/**
 * URL规范化工具
 * 处理微信环境和普通环境下的URL规范化
 */

/**
 * 从Hash路径中提取实际路径
 */
export const extractPathFromHash = (): string => {
  const hash = window.location.hash.slice(1); // 移除 # 符号
  return hash || '/';
};

/**
 * 规范化URL - 在微信环境中保持Hash路由稳定性
 */
export const normalizeUrl = (): void => {
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  if (isWeChat && window.location.hash) {
    const path = extractPathFromHash();
    
    // 微信环境下，保持Hash路由不变，避免破坏路由状态
    if (path && path !== '/') {
      console.log('🔒 微信环境保持Hash路由:', window.location.hash);
      // 不进行URL规范化，保持Hash路由
      return;
    }
  }
};

/**
 * 创建微信环境友好的URL
 */
export const createWeChatFriendlyUrl = (path: string): string => {
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  if (isWeChat) {
    // 微信环境使用Hash路由
    return `/#${path}`;
  } else {
    // 普通环境使用标准路径
    return path;
  }
};

/**
 * 创建分享链接
 */
export const createShareUrl = (path: string): string => {
  const baseUrl = 'https://news.aipush.fun';
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  if (isWeChat) {
    // 微信环境分享链接使用Hash路由
    return `${baseUrl}/#${path}`;
  } else {
    // 普通环境分享链接使用标准路径
    return `${baseUrl}${path}`;
  }
};

/**
 * 处理404重定向逻辑
 */
export const handle404Redirect = (): void => {
  const path = window.location.pathname;
  const search = window.location.search;
  const hash = window.location.hash;
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  console.log('处理404重定向:', { path, search, hash, isWeChat });
  
  if (isWeChat) {
    // 微信环境 - 使用Hash路由
    if (path !== '/' && path !== '/index.html') {
      const targetUrl = `/#${path}${search}${hash}`;
      console.log('微信环境重定向到:', targetUrl);
      window.location.replace(targetUrl);
    }
  } else {
    // 普通环境 - 使用标准重定向
    if (path !== '/' && path !== '/index.html') {
      const targetUrl = `/index.html?path=${encodeURIComponent(path + search + hash)}`;
      console.log('普通环境重定向到:', targetUrl);
      window.location.replace(targetUrl);
    }
  }
};

/**
 * 从查询参数中提取路径
 */
export const extractPathFromQuery = (): string => {
  const urlParams = new URLSearchParams(window.location.search);
  const path = urlParams.get('path');
  
  if (path) {
    try {
      return decodeURIComponent(path);
    } catch (error) {
      console.warn('解码路径失败:', error);
      return '/';
    }
  }
  
  return '/';
};

/**
 * 恢复URL历史记录 - 优化版
 */
export const restoreUrlHistory = (): void => {
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  if (!isWeChat) {
    // 清除404重定向标记
    sessionStorage.removeItem('is404Redirecting');
    
    // 首先检查sessionStorage中是否有404重定向保存的路径
    const redirectPath = sessionStorage.getItem('redirectPath');
    if (redirectPath) {
      console.log('恢复404重定向路径:', redirectPath);
      sessionStorage.removeItem('redirectPath'); // 清除已使用的路径
      try {
        // 验证路径是否有效
        if (redirectPath.startsWith('/') && redirectPath.length > 1) {
          window.history.replaceState({}, '', `${import.meta.env.BASE_URL}#${redirectPath}`);
          return;
        }
      } catch (error) {
        console.warn('恢复404重定向路径失败:', error);
      }
    }
    
    // 其次检查查询参数中的路径
    const path = extractPathFromQuery();
    if (path && path !== '/') {
      console.log('恢复查询参数路径:', path);
      try {
        // 验证路径是否有效
        if (path.startsWith('/') && path.length > 1) {
          window.history.replaceState({}, '', `${import.meta.env.BASE_URL}#${path}`);
        }
      } catch (error) {
        console.warn('恢复URL历史记录失败:', error);
      }
    }
  } else {
    // 微信环境也清除重定向标记
    sessionStorage.removeItem('is404Redirecting');
  }
};

/**
 * 获取当前路由路径
 */
export const getCurrentPath = (): string => {
  const isWeChat = /micromessenger/i.test(navigator.userAgent);
  
  if (isWeChat) {
    return extractPathFromHash();
  } else {
    return window.location.pathname;
  }
};

/**
 * 检查是否为新闻详情路径
 */
export const isNewsDetailPath = (path: string): boolean => {
  return /^\/news\/[^\/]+$/.test(path);
};

/**
 * 从路径中提取新闻ID
 */
export const extractNewsIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/news\/([^\/]+)$/);
  return match ? match[1] : null;
};

export default {
  normalizeUrl,
  createWeChatFriendlyUrl,
  createShareUrl,
  handle404Redirect,
  restoreUrlHistory,
  getCurrentPath,
  isNewsDetailPath,
  extractNewsIdFromPath
};