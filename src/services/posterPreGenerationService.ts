/**
 * 新闻海报预生成服务
 * 在用户浏览新闻时智能预生成分享海报，提升用户体验
 */

import { enhancedShareImageService } from './enhancedShareImageService';

interface NewsItem {
  id: string;
  title: string;
  summary: string;
  imageUrl?: string;
  publishedAt: string;
  source: string;
  category: string;
}

interface PreGenerationJob {
  newsId: string;
  priority: number;
  startTime: number;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  retryCount: number;
}

export class PosterPreGenerationService {
  private static instance: PosterPreGenerationService;
  private generationQueue: PreGenerationJob[] = [];
  private isProcessing: boolean = false;
  private maxConcurrent: number = 2;
  private currentlyGenerating: Set<string> = new Set();
  private intersectionObserver: IntersectionObserver | null = null;
  private visibilityThreshold: number = 0.1;
  private preGenerationDelay: number = 2000; // 2秒延迟预生成

  private constructor() {
    this.initializeIntersectionObserver();
    this.startQueueProcessor();
  }

  public static getInstance(): PosterPreGenerationService {
    if (!PosterPreGenerationService.instance) {
      PosterPreGenerationService.instance = new PosterPreGenerationService();
    }
    return PosterPreGenerationService.instance;
  }

  /**
   * 初始化可视性观察器
   */
  private initializeIntersectionObserver(): void {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      console.warn('IntersectionObserver not supported, pregeneration disabled');
      return;
    }

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const newsElement = entry.target as HTMLElement;
            const newsData = this.extractNewsDataFromElement(newsElement);
            
            if (newsData) {
              // 延迟预生成，避免用户快速滚动时浪费资源
              setTimeout(() => {
                if (this.isElementStillVisible(newsElement)) {
                  this.schedulePreGeneration(newsData);
                }
              }, this.preGenerationDelay);
            }
          }
        });
      },
      {
        threshold: this.visibilityThreshold,
        rootMargin: '50px' // 提前50px开始预加载
      }
    );
  }

  /**
   * 观察新闻元素
   */
  observeNewsElement(element: HTMLElement, newsData: NewsItem): void {
    if (!this.intersectionObserver) return;

    // 将新闻数据存储在元素上
    element.setAttribute('data-news-id', newsData.id);
    element.setAttribute('data-news-data', JSON.stringify(newsData));
    
    this.intersectionObserver.observe(element);
  }

  /**
   * 取消观察新闻元素
   */
  unobserveNewsElement(element: HTMLElement): void {
    if (!this.intersectionObserver) return;
    this.intersectionObserver.unobserve(element);
  }

  /**
   * 从元素中提取新闻数据
   */
  private extractNewsDataFromElement(element: HTMLElement): NewsItem | null {
    try {
      const newsDataStr = element.getAttribute('data-news-data');
      return newsDataStr ? JSON.parse(newsDataStr) : null;
    } catch (error) {
      console.warn('Failed to extract news data from element:', error);
      return null;
    }
  }

  /**
   * 检查元素是否仍然可见
   */
  private isElementStillVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const viewport = {
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth
    };

    return rect.bottom >= viewport.top && 
           rect.top <= viewport.bottom &&
           rect.right >= viewport.left && 
           rect.left <= viewport.right;
  }

  /**
   * 调度预生成任务
   */
  private schedulePreGeneration(newsData: NewsItem): void {
    // 检查是否已经在队列中或正在生成
    if (this.currentlyGenerating.has(newsData.id) || 
        this.generationQueue.some(job => job.newsId === newsData.id)) {
      return;
    }

    // 计算优先级（基于新闻新鲜度和类型）
    const priority = this.calculatePriority(newsData);

    const job: PreGenerationJob = {
      newsId: newsData.id,
      priority,
      startTime: Date.now(),
      status: 'pending',
      retryCount: 0
    };

    // 插入到队列的适当位置（按优先级排序）
    this.insertJobByPriority(job);

    console.log(`📅 调度预生成任务: ${newsData.title.substring(0, 50)}...`);
  }

  /**
   * 计算预生成优先级
   */
  private calculatePriority(newsData: NewsItem): number {
    let priority = 50; // 基础优先级

    // 时间因子：越新的新闻优先级越高
    const ageInHours = (Date.now() - new Date(newsData.publishedAt).getTime()) / (1000 * 60 * 60);
    if (ageInHours < 1) priority += 30;
    else if (ageInHours < 6) priority += 20;
    else if (ageInHours < 24) priority += 10;

    // 类型因子：热门类型优先级更高（统一两领域分类）
    const hotCategories = ['大模型', '具身智能'];
    if (hotCategories.some(cat => newsData.category.includes(cat))) {
      priority += 20;
    }

    // 来源因子：权威来源优先级更高
    const authoritiveSources = ['TechCrunch', 'The Verge', 'Wired'];
    if (authoritiveSources.some(source => newsData.source.includes(source))) {
      priority += 15;
    }

    return priority;
  }

  /**
   * 按优先级插入任务
   */
  private insertJobByPriority(job: PreGenerationJob): void {
    let insertIndex = this.generationQueue.length;
    
    for (let i = 0; i < this.generationQueue.length; i++) {
      if (this.generationQueue[i].priority < job.priority) {
        insertIndex = i;
        break;
      }
    }

    this.generationQueue.splice(insertIndex, 0, job);
    
    // 限制队列长度，移除最低优先级的任务
    if (this.generationQueue.length > 20) {
      this.generationQueue = this.generationQueue.slice(0, 20);
    }
  }

  /**
   * 启动队列处理器
   */
  private startQueueProcessor(): void {
    setInterval(async () => {
      if (!this.isProcessing && this.generationQueue.length > 0) {
        await this.processQueue();
      }
    }, 1000);
  }

  /**
   * 处理生成队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    
    this.isProcessing = true;

    try {
      const concurrentJobs = this.generationQueue
        .filter(job => job.status === 'pending')
        .slice(0, this.maxConcurrent);

      if (concurrentJobs.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.log(`🔄 开始处理${concurrentJobs.length}个预生成任务`);

      const promises = concurrentJobs.map(async (job) => {
        job.status = 'generating';
        this.currentlyGenerating.add(job.newsId);

        try {
          // 获取完整的新闻数据（模拟）
          const newsData = await this.getNewsData(job.newsId);
          if (!newsData) {
            throw new Error('News data not found');
          }

          // 使用低优先级进行预生成
          await enhancedShareImageService.generateShareImage(newsData, {
            useAI: true,
            priority: 'low',
            style: enhancedShareImageService.getOptimalStyle(newsData),
            cacheEnabled: true,
            fallbackToCanvas: true
          });

          job.status = 'completed';
          console.log(`✅ 预生成完成: ${newsData.title.substring(0, 30)}...`);

        } catch (error) {
          job.retryCount++;
          if (job.retryCount >= 2) {
            job.status = 'failed';
            console.warn(`❌ 预生成失败: ${job.newsId}`, error);
          } else {
            job.status = 'pending';
            console.warn(`🔄 预生成重试: ${job.newsId} (${job.retryCount}/2)`);
          }
        } finally {
          this.currentlyGenerating.delete(job.newsId);
        }
      });

      await Promise.allSettled(promises);

      // 清理已完成和失败的任务
      this.generationQueue = this.generationQueue.filter(
        job => job.status !== 'completed' && job.status !== 'failed'
      );

    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 获取新闻数据（这里应该连接到你的数据源）
   */
  private async getNewsData(newsId: string): Promise<NewsItem | null> {
    try {
      // 这里应该从实际的数据源获取
      // 暂时返回模拟数据
      const elements = document.querySelectorAll(`[data-news-id="${newsId}"]`);
      if (elements.length > 0) {
        return this.extractNewsDataFromElement(elements[0] as HTMLElement);
      }
      return null;
    } catch (error) {
      console.error('Error fetching news data:', error);
      return null;
    }
  }

  /**
   * 手动触发热门新闻预生成
   */
  async preGenerateHotNews(newsList: NewsItem[]): Promise<void> {
    console.log(`🔥 开始预生成${newsList.length}条热门新闻海报`);

    newsList.forEach(news => {
      this.schedulePreGeneration(news);
    });
  }

  /**
   * 获取预生成统计信息
   */
  getStats(): {
    queueLength: number;
    currentlyGenerating: number;
    completedToday: number;
    failedToday: number;
  } {
    return {
      queueLength: this.generationQueue.length,
      currentlyGenerating: this.currentlyGenerating.size,
      completedToday: 0, // 可以添加持久化统计
      failedToday: 0
    };
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }
    this.generationQueue = [];
    this.currentlyGenerating.clear();
  }
}

export const posterPreGenerationService = PosterPreGenerationService.getInstance();