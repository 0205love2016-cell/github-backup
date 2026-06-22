/**
 * @file app.js
 * @description GitHub 備份工具主邏輯
 *   - 拖曳資料夾讀取所有檔案
 *   - 驗證 GitHub Token
 *   - 建立或確認 Repo 存在
 *   - 完整同步：清除 repo 舊版本 -> 上傳所有新檔案
 *
 * 純前端，直接呼叫 GitHub REST API，不需要任何 server。
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** 單次 PUT /contents 之間的延遲（ms），避免觸發 GitHub rate limit */
const UPLOAD_DELAY_MS = 150;

/** 需要忽略不備份的路徑（精確資料夾名稱或檔案名稱） */
const IGNORE_PATTERNS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
]);

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const inputToken = document.getElementById('input-token');
const checkboxSaveToken = document.getElementById('checkbox-save-token');
const btnToggleToken = document.getElementById('btn-toggle-token');
const iconEyeOpen = btnToggleToken.querySelector('.icon-eye--open');
const iconEyeClosed = btnToggleToken.querySelector('.icon-eye--closed');
const errorToken = document.getElementById('error-token');

const inputRepo = document.getElementById('input-repo');
const repoHistory = document.getElementById('repo-history');
const errorRepo = document.getElementById('error-repo');

const btnPrivate = document.getElementById('btn-private');
const btnPublic = document.getElementById('btn-public');

const dropzone = document.getElementById('dropzone');
const dzContentIdle = document.getElementById('dropzone-content-idle');
const dzContentReading = document.getElementById('dropzone-content-reading');
const dzContentReady = document.getElementById('dropzone-content-ready');
const dzFileCount = document.getElementById('dropzone-file-count');
const dzReadingCount = document.getElementById('dropzone-reading-count');

const btnBackup = document.getElementById('btn-backup');
const btnResetFiles = document.getElementById('btn-reset-files');

const sectionProgress = document.getElementById('section-progress');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressBarTrack = document.getElementById('progress-bar-track');
const progressPercentage = document.getElementById('progress-percentage');
const progressStatus = document.getElementById('progress-status');

const sectionResult = document.getElementById('section-result');
const resultMessage = document.getElementById('result-message');
const resultLink = document.getElementById('result-link');
const btnBackupAnother = document.getElementById('btn-backup-another');

const sectionError = document.getElementById('section-error');
const errorMessage = document.getElementById('error-message');
const btnRetry = document.getElementById('btn-retry');

const resultConfetti = document.getElementById('result-confetti');

/** Folder picker input (webkitdirectory) — more reliable than FileSystemEntry on Windows */
const folderInput = document.getElementById('folder-input');
const btnBrowse = document.getElementById('btn-browse');

/** README auto-generate toggle */
const checkboxReadme = document.getElementById('checkbox-readme');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'private'|'public'} */
let repoVisibility = 'private';

/** @type {Array<{path: string, file: File}>} */
let collectedFiles = [];

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

/**
 * Builds standard headers for GitHub REST API requests.
 * @param {string} token - GitHub Personal Access Token.
 * @returns {Record<string, string>}
 */
function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Reads a File as base64 string.
 * Uses ArrayBuffer → btoa (chunked) to avoid Data URL length limitations
 * that occur with readAsDataURL on large files.
 * @param {File} file
 * @returns {Promise<string>} Base64-encoded content.
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        resolve(btoa(binary));
      } catch (e) {
        reject(new Error(`Base64 轉換失敗：${file.name} — ${e.message}`));
      }
    };
    reader.onerror = () => {
      const errName = reader.error ? reader.error.name : 'UnknownError';
      const errMsg = reader.error ? reader.error.message : '';
      let detail = '請確認該檔案未被其他程式（例如 Python 腳本或編輯器）獨佔開啟鎖定，且檔案未被移動或刪除。';
      if (errName === 'NotReadableError') {
        detail = '該檔案正被其他程式（例如 Python 腳本）獨佔鎖定或權限不足，請關閉可能佔用此檔案的程式後重試。';
      } else if (errName === 'NotFoundError') {
        detail = '找不到檔案，請確認在選取資料夾後，檔案未被移動或刪除。';
      }
      reject(new Error(`無法讀取檔案：${file.name}\n原因：${errName} (${errMsg})\n建議：${detail}`));
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Validates the token and returns the authenticated user's login.
 * @param {string} token
 * @returns {Promise<string>} GitHub username.
 * @throws {Error}
 */
async function getUser(token) {
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Token 驗證失敗（${res.status}）：請確認 Token 是否有效且具備 repo scope。`);
  }
  const data = await res.json();
  return data.login;
}

/**
 * Checks whether the repo exists under the authenticated user.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<boolean>}
 */
async function checkRepoExists(token, owner, repo) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: buildHeaders(token),
  });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`查詢 Repository 失敗（${res.status}）`);
}

/**
 * Creates a new repository.
 * @param {string} token
 * @param {string} repoName
 * @param {'private'|'public'} visibility
 * @returns {Promise<string>} Repo HTML URL.
 */
async function createRepo(token, repoName, visibility) {
  const res = await fetch(`${GITHUB_API}/user/repos`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      name: repoName,
      description: 'Project backup — created by GitHub Backup Tool',
      private: visibility === 'private',
      auto_init: false,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body.errors?.[0]?.message || body.message || res.status;
    throw new Error(`建立 Repository 失敗：${msg}`);
  }
  const data = await res.json();
  return data.html_url;
}

/**
 * Fetches all files in the repository recursively via git tree API.
 * Returns an empty array if the repo has no commits yet.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{path: string, sha: string, type: string}>>}
 */
async function getRepoTree(token, owner, repo) {
  // First, get the default branch SHA
  const branchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches/main`, {
    headers: buildHeaders(token),
  });

  if (branchRes.status === 404) {
    // Branch doesn't exist yet (empty repo)
    return [];
  }

  if (!branchRes.ok) {
    throw new Error(`取得分支資訊失敗（${branchRes.status}）`);
  }

  const branchData = await branchRes.json();
  const treeSha = branchData.commit.commit.tree.sha;

  const treeRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    { headers: buildHeaders(token) }
  );

  if (!treeRes.ok) {
    throw new Error(`取得 Repository 檔案樹失敗（${treeRes.status}）`);
  }

  const treeData = await treeRes.json();
  return treeData.tree.filter((item) => item.type === 'blob');
}

/**
 * Deletes a single file from the repository.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - File path in the repo.
 * @param {string} sha - Blob SHA of the file.
 * @returns {Promise<void>}
 */
async function deleteFile(token, owner, repo, path, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'DELETE',
    headers: buildHeaders(token),
    body: JSON.stringify({
      message: `backup: remove ${path}`,
      sha,
    }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`刪除檔案失敗：${path}（${res.status}）`);
  }
}

/**
 * Uploads (creates or updates) a single file to the repository.
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - File path in the repo.
 * @param {string} base64Content - Base64-encoded file content.
 * @param {string|null} existingSha - SHA of the existing file blob (for updates). Null for new files.
 * @returns {Promise<void>}
 */
async function uploadFile(token, owner, repo, path, base64Content, existingSha) {
  const body = {
    message: `backup: update ${path}`,
    content: base64Content,
  };
  if (existingSha) {
    body.sha = existingSha;
  }

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`上傳檔案失敗：${path}（${res.status}）${errData.message ? ' — ' + errData.message : ''}`);
  }
}

// ---------------------------------------------------------------------------
// File reading — FileSystemEntry API (recursive folder traversal)
// ---------------------------------------------------------------------------

/**
 * Recursively reads a FileSystemDirectoryEntry and collects all files.
 * @param {FileSystemDirectoryEntry} dirEntry
 * @param {string} basePath - Accumulated path prefix.
 * @param {Array<{path: string, file: File}>} results - Output array.
 * @returns {Promise<void>}
 */
function readDirectoryEntry(dirEntry, basePath, results) {
  // This function ALWAYS resolves, never rejects.
  // Any error in readEntries or file access is silently skipped.
  return new Promise((resolve) => {
    const reader = dirEntry.createReader();
    const allEntries = [];

    /**
     * FileSystemDirectoryReader.readEntries() only returns up to 100 entries at a time.
     * We must call it repeatedly until it returns an empty array.
     * On error (e.g. path too long on Windows), we resolve with what we have.
     */
    function readBatch() {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          // All entries collected; process them
          const promises = allEntries.map((entry) => {
            const entryName = entry.name;

            // Skip ignored paths
            if (IGNORE_PATTERNS.has(entryName) || entryName.startsWith('.')) {
              return Promise.resolve();
            }

            const entryPath = basePath ? `${basePath}/${entryName}` : entryName;

            if (entry.isDirectory) {
              // Recursively read subdirectory — errors are caught inside
              return readDirectoryEntry(entry, entryPath, results);
            } else {
              return new Promise((res) => {
                entry.file((file) => {
                  results.push({ path: entryPath, file });
                  dzReadingCount.textContent = `已讀取 ${results.length} 個檔案...`;
                  res();
                }, () => {
                  // Skip files that fail to resolve (path too long, special chars, etc.)
                  console.warn(`跳過無法讀取的檔案：${entryPath}`);
                  res();
                });
              });
            }
          });

          // Always resolve — even if some entries fail
          Promise.all(promises).then(resolve).catch(resolve);
        } else {
          allEntries.push(...entries);
          readBatch();
        }
      }, (err) => {
        // readEntries() failed (e.g. Windows path length limit inside node_modules)
        // Resolve with whatever we have collected so far — do NOT propagate.
        console.warn(`readEntries 失敗，跳過此目錄 (${basePath || 'root'}):`, err?.message || err);
        resolve();
      });
    }

    readBatch();
  });
}

/**
 * Reads a dropped DataTransferItemList and collects all files.
 * @param {DataTransferItemList} items
 * @returns {Promise<Array<{path: string, file: File}>>}
 */
async function collectFilesFromDrop(items) {
  const results = [];
  const promises = [];

  for (const item of items) {
    if (item.kind !== 'file') continue;

    const entry = item.webkitGetAsEntry?.();
    if (!entry) continue;

    if (entry.isDirectory) {
      // readDirectoryEntry always resolves — errors are handled internally
      promises.push(readDirectoryEntry(entry, '', results));
    } else if (entry.isFile) {
      promises.push(
        new Promise((resolve) => {
          entry.file((file) => {
            results.push({ path: file.name, file });
            resolve();
          }, () => resolve()); // skip on error
        })
      );
    }
  }

  await Promise.all(promises);
  return results;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Shows one dropzone content panel and hides the others.
 * @param {'idle'|'reading'|'ready'} state
 */
function setDropzoneState(state) {
  dzContentIdle.classList.toggle('dropzone__content--hidden', state !== 'idle');
  dzContentReading.classList.toggle('dropzone__content--hidden', state !== 'reading');
  dzContentReady.classList.toggle('dropzone__content--hidden', state !== 'ready');
}

/**
 * Shows a specific section card and hides others.
 * @param {'dropzone'|'progress'|'result'|'error'} section
 */
function showSection(section) {
  sectionProgress.classList.toggle('card--hidden', section !== 'progress');
  sectionResult.classList.toggle('card--hidden', section !== 'result');
  sectionError.classList.toggle('card--hidden', section !== 'error');
}

/**
 * Updates the progress bar and percentage label.
 * @param {number} value - 0–100.
 */
function setProgress(value) {
  const clamped = Math.min(100, Math.max(0, value));
  progressBarFill.style.width = `${clamped}%`;
  progressBarTrack.setAttribute('aria-valuenow', String(clamped));
  progressPercentage.textContent = `${Math.round(clamped)}%`;
}

/**
 * Sets the progress step state.
 * @param {'validate'|'repo'|'clear'|'upload'} stepId
 * @param {'active'|'done'|'idle'} state
 */
function setStep(stepId, state) {
  const el = document.getElementById(`step-${stepId}`);
  if (!el) return;
  el.classList.remove('progress-step--active', 'progress-step--done');
  if (state === 'active') el.classList.add('progress-step--active');
  if (state === 'done') el.classList.add('progress-step--done');
}

/**
 * Updates the status text below the progress steps.
 * @param {string} text
 */
function setStatus(text) {
  progressStatus.textContent = text;
}

/**
 * Resets all progress steps to idle.
 */
function resetSteps() {
  ['validate', 'repo', 'clear', 'upload'].forEach((s) => setStep(s, 'idle'));
}

/**
 * Launches confetti animation particles.
 */
function launchConfetti() {
  resultConfetti.innerHTML = '';
  const colors = ['#a855f7', '#06b6d4', '#34d399', '#fbbf24', '#f472b6'];
  const count = 30;

  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.setProperty('--confetti-duration', `${1.2 + Math.random() * 1.5}s`);
    piece.style.setProperty('--confetti-delay', `${Math.random() * 0.6}s`);
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    resultConfetti.appendChild(piece);
  }
}

/**
 * Sleeps for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates the token input field.
 * @returns {string|null} Token value or null if invalid.
 */
function validateToken() {
  const token = inputToken.value.trim();
  errorToken.textContent = '';
  inputToken.classList.remove('form-input--invalid');

  if (!token) {
    errorToken.textContent = 'Token 不可為空。';
    inputToken.classList.add('form-input--invalid');
    return null;
  }
  return token;
}

/**
 * Validates the repo name input field.
 * @returns {string|null} Repo name or null if invalid.
 */
function validateRepoName() {
  const name = inputRepo.value.trim();
  errorRepo.textContent = '';
  inputRepo.classList.remove('form-input--invalid');

  if (!name) {
    errorRepo.textContent = 'Repository 名稱不可為空。';
    inputRepo.classList.add('form-input--invalid');
    return null;
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    errorRepo.textContent = '只允許小寫英文、數字與連字號，且不能以連字號開頭。';
    inputRepo.classList.add('form-input--invalid');
    return null;
  }

  return name;
}

// ---------------------------------------------------------------------------
// Token persistence
// ---------------------------------------------------------------------------

(function initTokenPersistence() {
  const saved = localStorage.getItem('gh_backup_token');
  if (saved) {
    inputToken.value = saved;
    checkboxSaveToken.checked = true;
  }
})();

(function initRepoHistory() {
  const history = JSON.parse(localStorage.getItem('gh_backup_repo_history') || '[]');
  history.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    repoHistory.appendChild(option);
  });
})();

/**
 * Saves the repo name to the datalist history (max 5 entries).
 * @param {string} name
 */
function saveRepoToHistory(name) {
  let history = JSON.parse(localStorage.getItem('gh_backup_repo_history') || '[]');
  history = [name, ...history.filter((n) => n !== name)].slice(0, 5);
  localStorage.setItem('gh_backup_repo_history', JSON.stringify(history));

  // Rebuild datalist
  repoHistory.innerHTML = '';
  history.forEach((n) => {
    const option = document.createElement('option');
    option.value = n;
    repoHistory.appendChild(option);
  });
}

// ---------------------------------------------------------------------------
// Event listeners — Token visibility toggle
// ---------------------------------------------------------------------------

btnToggleToken.addEventListener('click', () => {
  const isPassword = inputToken.type === 'password';
  inputToken.type = isPassword ? 'text' : 'password';
  iconEyeOpen.style.display = isPassword ? 'none' : '';
  iconEyeClosed.style.display = isPassword ? '' : 'none';
});

// ---------------------------------------------------------------------------
// Event listeners — Visibility toggle
// ---------------------------------------------------------------------------

[btnPrivate, btnPublic].forEach((btn) => {
  btn.addEventListener('click', () => {
    repoVisibility = btn.dataset.value;
    btnPrivate.classList.toggle('visibility-btn--active', repoVisibility === 'private');
    btnPublic.classList.toggle('visibility-btn--active', repoVisibility === 'public');
    btnPrivate.setAttribute('aria-pressed', String(repoVisibility === 'private'));
    btnPublic.setAttribute('aria-pressed', String(repoVisibility === 'public'));
  });
});

// ---------------------------------------------------------------------------
// Event listeners — Drop Zone
// ---------------------------------------------------------------------------

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dropzone--active');
});

dropzone.addEventListener('dragleave', (e) => {
  if (!dropzone.contains(e.relatedTarget)) {
    dropzone.classList.remove('dropzone--active');
  }
});

dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('dropzone--active');

  const items = e.dataTransfer?.items;
  if (!items || items.length === 0) return;

  setDropzoneState('reading');
  dzReadingCount.textContent = '正在掃描資料夾...';

  collectedFiles = await collectFilesFromDrop(items);

  if (collectedFiles.length === 0) {
    setDropzoneState('idle');
    showError('拖曳讀取失敗：未讀到任何檔案。\n請改用「選擇資料夾」按鈕來選取。');
    return;
  }

  dzFileCount.textContent = `共 ${collectedFiles.length} 個檔案`;
  setDropzoneState('ready');
});

// ---------------------------------------------------------------------------
// Event listeners — Browse button (webkitdirectory input, more reliable on Windows)
// ---------------------------------------------------------------------------

/**
 * Processes a FileList from an <input webkitdirectory> element.
 * Filters ignored paths and collects {path, file} pairs.
 * @param {FileList} fileList
 * @returns {Array<{path: string, file: File}>}
 */
function processFileList(fileList) {
  const results = [];
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    // rel is like "folderName/subdir/file.ext"
    // Strip the top-level folder name so the repo path is just "subdir/file.ext"
    const parts = rel.split('/');

    // Check every part of the path against IGNORE_PATTERNS
    const shouldIgnore = parts.some(
      (part) => IGNORE_PATTERNS.has(part) || (part.startsWith('.') && part !== '.')
    );
    if (shouldIgnore) continue;

    // Remove top-level folder prefix (parts[0])
    const repoPath = parts.slice(1).join('/');
    if (!repoPath) continue; // skip if file is directly in the root (shouldn't happen with webkitdirectory)

    results.push({ path: repoPath, file });
  }
  return results;
}

btnBrowse.addEventListener('click', (e) => {
  e.stopPropagation(); // prevent dropzone click from also firing
  folderInput.value = ''; // reset so same folder can be re-selected
  folderInput.click();
});

folderInput.addEventListener('change', () => {
  if (!folderInput.files || folderInput.files.length === 0) return;

  setDropzoneState('reading');
  dzReadingCount.textContent = `正在處理 ${folderInput.files.length} 個檔案...`;

  // processFileList is synchronous — no async needed for input[webkitdirectory]
  collectedFiles = processFileList(folderInput.files);

  if (collectedFiles.length === 0) {
    setDropzoneState('idle');
    showError('未讀到任何檔案。請確認資料夾內有檔案，且不全部被忽略規則指定。');
    return;
  }

  dzFileCount.textContent = `共 ${collectedFiles.length} 個檔案`;
  setDropzoneState('ready');
});

// Keyboard: Enter/Space on dropzone opens folder picker
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    folderInput.value = '';
    folderInput.click();
  }
});

// ---------------------------------------------------------------------------
// Event listeners — Reset
// ---------------------------------------------------------------------------

btnResetFiles.addEventListener('click', () => {
  collectedFiles = [];
  setDropzoneState('idle');
});

btnBackupAnother.addEventListener('click', () => {
  collectedFiles = [];
  setDropzoneState('idle');
  showSection('dropzone');
  resetSteps();
  setProgress(0);
  setStatus('');
});

btnRetry.addEventListener('click', () => {
  showSection('dropzone');
  resetSteps();
  setProgress(0);
  setStatus('');
});

// ---------------------------------------------------------------------------
// Backup flow
// ---------------------------------------------------------------------------

btnBackup.addEventListener('click', runBackup);

/**
 * Orchestrates the full backup flow:
 * 1. Validate inputs
 * 2. Validate token → get username
 * 3. Create repo if it doesn't exist
 * 4. Clear existing files (complete sync)
 * 5. Upload all files from the dropped folder
 * @returns {Promise<void>}
 */
async function runBackup() {
  // --- Input validation ---
  const token = validateToken();
  const repoName = validateRepoName();
  if (!token || !repoName) return;

  // --- Persist token if requested ---
  if (checkboxSaveToken.checked) {
    localStorage.setItem('gh_backup_token', token);
  } else {
    localStorage.removeItem('gh_backup_token');
  }

  // --- Show progress UI ---
  showSection('progress');
  resetSteps();
  setProgress(0);
  setStatus('正在準備...');

  try {
    // ---- Step 1: Validate token ----
    setStep('validate', 'active');
    setStatus('正在驗證 Token...');
    const owner = await getUser(token);
    setStep('validate', 'done');
    setProgress(10);

    // ---- Step 2: Create or confirm repo ----
    setStep('repo', 'active');
    setStatus('正在確認 Repository...');
    let repoHtmlUrl;
    const exists = await checkRepoExists(token, owner, repoName);

    if (exists) {
      setStatus(`Repository "${repoName}" 已存在，準備更新...`);
      repoHtmlUrl = `https://github.com/${owner}/${repoName}`;
    } else {
      setStatus(`正在建立 Repository "${repoName}"...`);
      repoHtmlUrl = await createRepo(token, repoName, repoVisibility);
    }

    setStep('repo', 'done');
    setProgress(20);
    saveRepoToHistory(repoName);

    // ---- Step 3: Clear existing files ----
    setStep('clear', 'active');
    setStatus('正在取得現有檔案列表...');

    const existingTree = await getRepoTree(token, owner, repoName);

    if (existingTree.length > 0) {
      setStatus(`正在清除 ${existingTree.length} 個舊檔案...`);

      for (let i = 0; i < existingTree.length; i++) {
        const item = existingTree[i];
        await deleteFile(token, owner, repoName, item.path, item.sha);
        const deleteProgress = 20 + Math.round((i + 1) / existingTree.length * 20);
        setProgress(deleteProgress);
        setStatus(`正在清除舊檔案 (${i + 1}/${existingTree.length})：${item.path}`);
        await sleep(UPLOAD_DELAY_MS);
      }
    } else {
      setStatus('Repository 為空，跳過清除步驟。');
    }

    setStep('clear', 'done');
    setProgress(40);

    // ---- Step 4: Upload all files ----
    setStep('upload', 'active');

    // Build upload list — start with collected files
    const uploadList = collectedFiles.slice();

    // Optionally inject auto-generated README.md
    if (checkboxReadme && checkboxReadme.checked) {
      setStatus('正在分析專案結構並生成 README...');
      const readmeContent = await generateReadme(collectedFiles, repoName);

      // Remove any pre-existing README from the user's folder (we replace it)
      for (let i = uploadList.length - 1; i >= 0; i--) {
        if (uploadList[i].path.toLowerCase() === 'readme.md') {
          uploadList.splice(i, 1);
        }
      }

      // Inject README as a virtual File at the start of the list
      const readmeBlob = new Blob([readmeContent], { type: 'text/plain' });
      const readmeFile = new File([readmeBlob], 'README.md', { type: 'text/plain' });
      uploadList.unshift({ path: 'README.md', file: readmeFile });
    }

    const total = uploadList.length;
    setStatus('正在上傳檔案 (0/' + total + ')...');

    for (let i = 0; i < total; i++) {
      const { path, file } = uploadList[i];
      const base64 = path === 'README.md'
        ? textToBase64(await readFileAsText(file))
        : await readFileAsBase64(file);
      await uploadFile(token, owner, repoName, path, base64, null);

      const uploadProgress = 40 + Math.round((i + 1) / total * 59);
      setProgress(uploadProgress);
      setStatus('正在上傳 (' + (i + 1) + '/' + total + ')：' + path);
      await sleep(UPLOAD_DELAY_MS);
    }

    setStep('upload', 'done');
    setProgress(100);
    setStatus('備份完成！');

    // ---- Show result ----
    await sleep(600);
    const readmeNote = (checkboxReadme && checkboxReadme.checked) ? '（含自動生成的 README.md）' : '';
    resultMessage.textContent = '共 ' + total + ' 個檔案' + readmeNote + '已成功備份至 ' + owner + '/' + repoName + '。';
    resultLink.href = repoHtmlUrl;
    launchConfetti();
    showSection('result');

  } catch (err) {
    showError(err.message || '未知錯誤，請重試。');
  }
}

/**
 * Shows the error section with a given message.
 * @param {string} message
 */
function showError(message) {
  errorMessage.textContent = message;
  showSection('error');
}
