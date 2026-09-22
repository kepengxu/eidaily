// 最终版模板分享服务 - 使用用户指定的正确模板
class TemplateShareService {
    constructor() {
        this.baseUrl = new URL('./', document.currentScript.src).href;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.canvas.width = 800;
        this.canvas.height = 1200;
    }

    async generateShareImage(newsData) {
        try {
            console.log('🎨 开始生成分享图：', newsData.title);
            
            // 清空画布
            this.ctx.clearRect(0, 0, 800, 1200);
            
            // 加载模板背景
            await this.loadTemplateBackground();
            
            // 添加标题文字
            this.overlayTitleText(newsData.title);
            
            // 添加内容文字  
            this.overlayContentText(newsData.summary);
            
            // 添加QR码
            await this.overlayQRCode(newsData.id);
            
            console.log('✅ 分享图生成完成');
            return this.canvas.toDataURL('image/jpeg', 0.95);
        } catch (error) {
            console.error('❌ 分享图生成失败:', error);
            throw error;
        }
    }

    async loadTemplateBackground() {
        const templatePaths = [
            `${this.baseUrl}share-template-final.jpg`,      // 用户指定的最终模板
            `${this.baseUrl}template-original.jpg`,         // 备用模板1
            `${this.baseUrl}新闻图分享示意-空白.jpg`,       // 备用模板2
            './share-template-final.jpg',     // 相对路径备用
            './template-original.jpg',
            './新闻图分享示意-空白.jpg'
        ];
        
        for (const path of templatePaths) {
            try {
                console.log(`🔍 尝试加载模板: ${path}`);
                const templateImg = await this.loadImageWithTimeout(path, 12000);
                
                // 确保图片完全加载后再绘制
                if (templateImg.complete || templateImg.readyState === 4) {
                    this.ctx.drawImage(templateImg, 0, 0, 800, 1200);
                    console.log(`✅ 模板加载成功: ${path}`);
                    return;
                }
            } catch (error) {
                console.warn(`⚠️ 模板加载失败: ${path} - ${error.message}`);
                continue;
            }
        }
        
        console.error('❌ 所有模板加载失败，使用备用背景');
        this.drawFallbackBackground();
    }

    drawFallbackBackground() {
        // 绘制与模板相似的蓝色背景
        const gradient = this.ctx.createLinearGradient(0, 0, 0, 1200);
        gradient.addColorStop(0, '#4A90E2');
        gradient.addColorStop(1, '#7FB3D3');
        this.ctx.fillStyle = gradient;
        this.ctx.fillRect(0, 0, 800, 1200);
        
        // 白色内容卡片区域
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(80, 240, 640, 500);
        this.ctx.strokeStyle = '#e0e0e0';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(80, 240, 640, 500);
    }

    overlayTitleText(title) {
        console.log('📝 添加标题文字：', title);
        
        // 标题设置 - 在蓝色背景顶部区域显示白色标题  
        this.ctx.fillStyle = '#ffffff';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        // 标题位置 - 蓝色区域顶部
        const titleY = 140;
        let fontSize = 46;
        if (title.length > 25) fontSize = 38;
        else if (title.length > 18) fontSize = 42;
        
        this.ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
        
        const maxWidth = 680;
        const titleWidth = this.ctx.measureText(title).width;
        
        if (titleWidth > maxWidth) {
            // 智能分行：优先在冒号处分行
            let splitIndex = title.indexOf('：');
            if (splitIndex === -1 || splitIndex > title.length * 0.7) {
                splitIndex = Math.floor(title.length / 2);
            } else {
                splitIndex += 1;
            }
            
            const line1 = title.substring(0, splitIndex).trim();
            const line2 = title.substring(splitIndex).trim();
            
            // 检查分行后的宽度
            const line1Width = this.ctx.measureText(line1).width;
            const line2Width = this.ctx.measureText(line2).width;
            
            if (line1Width > maxWidth || line2Width > maxWidth) {
                fontSize = Math.max(32, fontSize - 6);
                this.ctx.font = `bold ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
            }
            
            this.ctx.fillText(line1, 400, titleY - 30);
            this.ctx.fillText(line2, 400, titleY + 30);
        } else {
            this.ctx.fillText(title, 400, titleY);
        }
    }

    overlayContentText(content) {
        console.log('📄 添加内容文字');
        
        // 内容文字 - 显示在白色卡片内
        this.ctx.fillStyle = '#333333';
        this.ctx.font = '28px "Microsoft YaHei", "PingFang SC", sans-serif';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        
        // 内容区域位置 - 白色卡片内部
        const contentX = 120;
        const contentY = 280; 
        const maxWidth = 560;
        const lineHeight = 40;
        
        let displayContent = content.length > 140 ? content.substring(0, 140) + '...' : content;
        const lines = this.wrapText(displayContent, maxWidth);
        
        // 最多显示8行文字
        lines.slice(0, 8).forEach((line, index) => {
            this.ctx.fillText(line, contentX, contentY + (index * lineHeight));
        });
    }

    async overlayQRCode(newsId) {
        console.log('🔲 添加QR码');
        
        // QR码位置 - 左下角
        const qrSize = 160;
        const qrX = 98;     // 向左移动 2 像素 (100 -> 98)
        const qrY = 980;    // 左下角Y坐标
        const newsUrl = `https://news.aipush.fun/#/news/${newsId}`;
        
        const qrApis = [
            `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodeURIComponent(newsUrl)}&format=png&margin=0&ecc=H&color=000000&bgcolor=ffffff`,
            `https://quickchart.io/qr?text=${encodeURIComponent(newsUrl)}&size=${qrSize}&format=png&ecLevel=H&margin=0&dark=000000&light=ffffff`,
            `https://chart.googleapis.com/chart?chs=${qrSize}x${qrSize}&cht=qr&chl=${encodeURIComponent(newsUrl)}&choe=UTF-8&chld=H|0`
        ];
        
        for (const apiUrl of qrApis) {
            try {
                console.log('🔍 尝试生成QR码:', apiUrl.substring(0, 50) + '...');
                const qrImg = await this.loadImageWithTimeout(apiUrl, 8000);
                this.ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
                console.log('✅ QR码生成成功');
                return;
            } catch (error) {
                console.warn('⚠️ QR码API失败:', error.message);
                continue;
            }
        }
        
        console.warn('❌ 所有QR码API都失败，绘制占位符');
        // 所有API都失败，绘制占位符
        this.ctx.fillStyle = '#f0f0f0';
        this.ctx.fillRect(qrX, qrY, qrSize, qrSize);
        this.ctx.strokeStyle = '#cccccc';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(qrX, qrY, qrSize, qrSize);
        
        // 添加占位文字
        this.ctx.fillStyle = '#666666';
        this.ctx.font = '16px "Microsoft YaHei"';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('二维码', qrX + qrSize/2, qrY + qrSize/2);
    }

    // 文字换行处理
    wrapText(text, maxWidth) {
        const lines = [];
        let currentLine = '';
        
        for (let i = 0; i < text.length; i++) {
            const testLine = currentLine + text[i];
            const testWidth = this.ctx.measureText(testLine).width;
            
            if (testWidth > maxWidth && currentLine !== '') {
                lines.push(currentLine);
                currentLine = text[i];
            } else {
                currentLine = testLine;
            }
        }
        
        if (currentLine !== '') {
            lines.push(currentLine);
        }
        
        return lines;
    }

    // 图片加载工具函数
    loadImageWithTimeout(src, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            
            const timeoutId = setTimeout(() => {
                reject(new Error(`图片加载超时: ${src}`));
            }, timeout);
            
            img.onload = () => {
                clearTimeout(timeoutId);
                resolve(img);
            };
            
            img.onerror = () => {
                clearTimeout(timeoutId);
                reject(new Error(`图片加载失败: ${src}`));
            };
            
            img.src = src;
        });
    }
}

// 全局实例
window.templateShareService = new TemplateShareService();
console.log('🎯 模板分享服务已初始化 - 使用最终正确模板');