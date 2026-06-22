// ---------------------------------------------------------------------------
// README Generator
// ---------------------------------------------------------------------------

/**
 * Reads a File object as UTF-8 text.
 * @param {File} file
 * @returns {Promise<string>}
 */
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => {
      const errName = reader.error ? reader.error.name : 'UnknownError';
      const errMsg = reader.error ? reader.error.message : '';
      let detail = '請確認該檔案未被其他程式（例如 Python 腳本或編輯器）獨佔開啟鎖定，且檔案未被移動或刪除。';
      if (errName === 'NotReadableError') {
        detail = '該檔案正被其他程式（例如 Python 腳本）獨佔鎖定或權限不足，請關閉可能佔用此檔案的程式後重試。';
      } else if (errName === 'NotFoundError') {
        detail = '找不到檔案，請確認檔案未被移動或刪除。';
      }
      reject(new Error(`無法讀取檔案：${file.name}\n原因：${errName} (${errMsg})\n建議：${detail}`));
    };
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Converts a UTF-8 string to base64 (handles multibyte chars safely).
 * @param {string} text
 * @returns {string}
 */
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Analyzes the collected file list and generates a README.md string.
 * Detects project type from package.json, requirements.txt, file extensions, etc.
 * @param {Array<{path: string, file: File}>} files
 * @param {string} repoName
 * @returns {Promise<string>} Markdown content for README.md
 */
async function generateReadme(files, repoName) {
  const paths = files.map((f) => f.path);

  // ---- Parse package.json ----
  let pkg = null;
  const pkgEntry = files.find((f) => f.path === 'package.json');
  if (pkgEntry) {
    try {
      const text = await readFileAsText(pkgEntry.file);
      pkg = JSON.parse(text);
    } catch (_) { pkg = null; }
  }

  // ---- Parse requirements.txt ----
  let pythonDeps = [];
  const reqEntry = files.find((f) => f.path === 'requirements.txt');
  if (reqEntry) {
    try {
      const text = await readFileAsText(reqEntry.file);
      pythonDeps = text
        .split('\n')
        .map((l) => l.trim().split(/[>=<!]/)[0].trim().toLowerCase())
        .filter(Boolean);
    } catch (_) {}
  }

  // ---- Detect project type ----
  const deps = Object.keys(Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies));
  const hasPkg = !!pkg;
  const isNext    = deps.includes('next');
  const isNuxt    = deps.includes('nuxt');
  const isReact   = deps.some((d) => d === 'react' || d === 'react-dom');
  const isVue     = deps.includes('vue');
  const isVite    = deps.includes('vite');
  const isExpress = deps.some((d) => d === 'express' || d === 'fastify' || d === 'koa');
  const isElectron = deps.includes('electron');
  const isPython  = pythonDeps.length > 0 || paths.some((p) => p.endsWith('.py'));
  const isDjango  = pythonDeps.includes('django');
  const isFlask   = pythonDeps.includes('flask');
  const isFastapi = pythonDeps.includes('fastapi');
  const hasDockerfile     = paths.includes('Dockerfile');
  const hasDockerCompose  = paths.includes('docker-compose.yml') || paths.includes('docker-compose.yaml');
  const hasTests  = paths.some((p) => /^(tests?|__tests?__)\//.test(p));
  const hasEnvExample = paths.includes('.env.example');
  const hasIndexHtml  = paths.includes('index.html') || paths.includes('public/index.html');

  let projectType = 'Project';
  if (isNext)              projectType = 'Next.js 全端應用';
  else if (isNuxt)         projectType = 'Nuxt.js 全端應用';
  else if (isReact && isVite) projectType = 'React + Vite 應用';
  else if (isReact)        projectType = 'React 應用';
  else if (isVue)          projectType = 'Vue.js 應用';
  else if (isExpress)      projectType = 'Node.js API 伺服器';
  else if (isElectron)     projectType = 'Electron 桌面應用';
  else if (hasPkg && hasIndexHtml) projectType = '靜態網站（Node.js 工具）';
  else if (hasIndexHtml)   projectType = '靜態網站';
  else if (isDjango)       projectType = 'Django Web 應用';
  else if (isFlask)        projectType = 'Flask API 伺服器';
  else if (isFastapi)      projectType = 'FastAPI 應用';
  else if (isPython)       projectType = 'Python 專案';

  // ---- Collect directory structure (top 2 levels) ----
  const topDirs = new Set();
  const topFiles = [];
  paths.forEach((p) => {
    const parts = p.split('/');
    if (parts.length === 1) {
      topFiles.push(p);
    } else {
      topDirs.add(parts[0] + '/');
    }
  });
  const structureLines = [
    ...Array.from(topDirs).sort(),
    ...topFiles.sort(),
  ].map((item) => '\u251c\u2500\u2500 ' + item);

  // ---- Build scripts section ----
  const scripts = (pkg && pkg.scripts) || {};
  const scriptLines = Object.entries(scripts)
    .filter(function(entry) { return ['dev','start','build','test','lint'].includes(entry[0]); })
    .map(function(entry) { return 'npm run ' + entry[0] + '   # ' + entry[1]; });

  // ---- Tech stack table ----
  const techRows = [];
  if (isNext)    techRows.push(['全端框架', 'Next.js ' + ((pkg && pkg.dependencies && pkg.dependencies.next) || '')]);
  else if (isNuxt) techRows.push(['全端框架', 'Nuxt ' + ((pkg && pkg.dependencies && pkg.dependencies.nuxt) || '')]);
  if (isReact)   techRows.push(['UI 框架', 'React ' + ((pkg && pkg.dependencies && pkg.dependencies.react) || '')]);
  if (isVue)     techRows.push(['UI 框架', 'Vue ' + ((pkg && pkg.dependencies && pkg.dependencies.vue) || '')]);
  if (isVite)    techRows.push(['建置工具', 'Vite ' + ((pkg && pkg.devDependencies && pkg.devDependencies.vite) || '')]);
  if (isExpress) techRows.push(['後端框架', 'Express ' + ((pkg && pkg.dependencies && pkg.dependencies.express) || '')]);
  if (isDjango)  techRows.push(['後端框架', 'Django']);
  if (isFlask)   techRows.push(['後端框架', 'Flask']);
  if (isFastapi) techRows.push(['後端框架', 'FastAPI']);
  if (hasDockerfile) techRows.push(['容器化', 'Docker']);
  if (hasDockerCompose) techRows.push(['編排', 'Docker Compose']);
  if (hasPkg) techRows.push(['執行環境', ('Node.js ' + ((pkg && pkg.engines && pkg.engines.node) || '')).trim()]);
  else if (isPython) techRows.push(['執行環境', 'Python 3']);

  // ---- Compose README ----
  const name = (pkg && pkg.name) || repoName;
  const version = (pkg && pkg.version) ? ' v' + pkg.version : '';
  const description = (pkg && pkg.description) || (projectType + '，使用 GitHub Backup Tool 備份。');
  const today = new Date().toLocaleDateString('zh-TW');

  const lines = [];

  lines.push('# ' + name + version);
  lines.push('');
  lines.push('> ' + description);
  lines.push('');

  // Badges
  if (hasPkg) {
    lines.push('![Node](https://img.shields.io/badge/runtime-Node.js-339933?logo=node.js)');
  } else if (isPython) {
    lines.push('![Python](https://img.shields.io/badge/runtime-Python-3776AB?logo=python)');
  }
  if (hasDockerfile) {
    lines.push('![Docker](https://img.shields.io/badge/containerized-Docker-2496ED?logo=docker)');
  }
  lines.push('');

  // Tech stack
  if (techRows.length > 0) {
    lines.push('## 技術棧');
    lines.push('');
    lines.push('| 類別 | 技術 |');
    lines.push('|------|------|');
    techRows.forEach(function(row) { lines.push('| ' + row[0] + ' | ' + row[1].trim() + ' |'); });
    lines.push('');
  }

  // Quick start
  lines.push('## 快速開始');
  lines.push('');

  if (hasPkg) {
    lines.push('### 安裝相依套件');
    lines.push('');
    lines.push('```bash');
    lines.push('npm install');
    lines.push('```');
    lines.push('');
  } else if (isPython) {
    lines.push('### 安裝相依套件');
    lines.push('');
    lines.push('```bash');
    lines.push('pip install -r requirements.txt');
    lines.push('```');
    lines.push('');
  }

  if (hasEnvExample) {
    lines.push('### 環境變數');
    lines.push('');
    lines.push('```bash');
    lines.push('cp .env.example .env');
    lines.push('# 編輯 .env 填入必要的設定值');
    lines.push('```');
    lines.push('');
  }

  if (scriptLines.length > 0) {
    lines.push('### 啟動');
    lines.push('');
    lines.push('```bash');
    scriptLines.forEach(function(l) { lines.push(l); });
    lines.push('```');
    lines.push('');
  } else if (isPython) {
    lines.push('### 啟動');
    lines.push('');
    lines.push('```bash');
    lines.push('python main.py');
    lines.push('```');
    lines.push('');
  }

  // Project structure
  if (structureLines.length > 0) {
    lines.push('## 專案結構');
    lines.push('');
    lines.push('```');
    lines.push(repoName + '/');
    structureLines.forEach(function(l) { lines.push(l); });
    lines.push('```');
    lines.push('');
  }

  // Tests
  if (hasTests) {
    const testCmd = scripts.test ? 'npm run test' : (isPython ? 'pytest' : 'npm test');
    lines.push('## 執行測試');
    lines.push('');
    lines.push('```bash');
    lines.push(testCmd);
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('*本專案由 [GitHub Backup Tool](https://github.com) 自動備份 — ' + today + '*');
  lines.push('');

  return lines.join('\n');
}
