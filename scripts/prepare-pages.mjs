import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
// 只处理构建产物；未明确列出的文件不进入公开部署包。
const files = new Set([
  'index.html', '.nojekyll', 'sw.js',
  'news-data.json', 'news-archive.json', 'robodojo-news.json',
  'suyxh-source-status.json', 'version.json', 'blog-data.json', 'feed.json', 'rss.xml',
  'favicon.svg', 'favicon.ico', 'favicon-large.svg', 'placeholder.svg',
  'wechat-share-300.png', 'wechat-share-300.svg', 'wechat-share-500.svg',
  'wechat-thumb.png', 'wechat-thumb.svg', 'cat-share-300.svg', 'share-icon.svg',
  'share-template-blank.jpg', 'share-template-final.jpg', 'share-template-sample.jpg',
  'template-original.jpg', '新闻图分享示意-空白.jpg',
  'templateShareService.js', 'shareEnhancer.js', 'wechat-share-proxy.html',
]);

export function isPagesFile(name) {
  return files.has(name)
    || /^assets\/[\w.-]+\.(?:js|css|woff2?|ttf|png|jpe?g|svg|webp|gif|ico)$/.test(name)
    || /^robodojo-news-history\/\d{4}-\d{2}-\d{2}\.json$/.test(name)
    || /^blog\/[\p{L}\p{N}_.-]+\.html$/u.test(name);
}

export function preparePages(directory = dist) {
  if (path.resolve(directory) !== dist) throw new Error('仅允许清理本项目 dist 构建目录');
  if (fs.lstatSync(dist).isSymbolicLink()) throw new Error('dist 不得为符号链接');
  const removed = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(dist, file).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(file);
        if (!fs.readdirSync(file).length) fs.rmdirSync(file);
      } else if (entry.isSymbolicLink() || !isPagesFile(relative)) {
        fs.unlinkSync(file);
        removed.push(relative);
      }
    }
  }
  walk(dist);
  for (const name of ['index.html', 'news-data.json', 'version.json', 'robodojo-news.json']) {
    if (!fs.existsSync(path.join(dist, name))) throw new Error(`缺少必要产物：${name}`);
  }
  console.log(`Pages 产物清理完成，移除 ${removed.length} 个无关文件；public 原始文件未修改。`);
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) preparePages();
