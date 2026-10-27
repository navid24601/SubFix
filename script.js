// ════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════
let videoFiles = [];   // [{file, name, ext, index}]
let subFiles   = [];   // [{file, name, ext, index, matchedTo, newName, rawBuffer, peekText}]
let pendingMatches = []; // [{subIdx, vidIdx, newName}]
let currentEncoding = 'windows-1256';

// ════════════════════════════════════════════════════════════════════════
// CRC32 TABLE (for ZIP)
// ════════════════════════════════════════════════════════════════════════
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++)
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ════════════════════════════════════════════════════════════════════════
// MINIMAL ZIP BUILDER (Store, no compression — pure JS, no libraries)
// To use JSZip instead: paste JSZip source below this comment block
// and replace the createZip() function call in downloadZip() with JSZip API.
// ════════════════════════════════════════════════════════════════════════
function createZip(entries) {
  // entries: Array of {name: string, data: Uint8Array}
  const enc = new TextEncoder();
  const localChunks  = [];
  const centralDir   = [];
  let   offset       = 0;

  const dosTime = (() => {
    const d = new Date();
    const t = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    const dt = (((d.getFullYear()-1980) & 0x7F) << 9) | (((d.getMonth()+1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { t, dt };
  })();

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data      = entry.data;
    const crc       = crc32(data);
    const sz        = data.length;

    // Local file header (30 bytes + name)
    const lh = new DataView(new ArrayBuffer(30 + nameBytes.length));
    lh.setUint32(0,  0x04034B50, true); // signature
    lh.setUint16(4,  20,         true); // version needed
    lh.setUint16(6,  0x0800,     true); // flags (UTF-8 name)
    lh.setUint16(8,  0,          true); // method: stored
    lh.setUint16(10, dosTime.t,  true);
    lh.setUint16(12, dosTime.dt, true);
    lh.setUint32(14, crc,        true);
    lh.setUint32(18, sz,         true); // compressed size
    lh.setUint32(22, sz,         true); // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0,          true); // extra length
    const lhArr = new Uint8Array(lh.buffer);
    lhArr.set(nameBytes, 30);

    localChunks.push(lhArr, data);

    // Central directory record (46 bytes + name)
    const cd = new DataView(new ArrayBuffer(46 + nameBytes.length));
    cd.setUint32(0,  0x02014B50, true);
    cd.setUint16(4,  20,         true);
    cd.setUint16(6,  20,         true);
    cd.setUint16(8,  0x0800,     true);
    cd.setUint16(10, 0,          true);
    cd.setUint16(12, dosTime.t,  true);
    cd.setUint16(14, dosTime.dt, true);
    cd.setUint32(16, crc,        true);
    cd.setUint32(20, sz,         true);
    cd.setUint32(24, sz,         true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0,  true); // extra
    cd.setUint16(32, 0,  true); // comment
    cd.setUint16(34, 0,  true); // disk start
    cd.setUint16(36, 0,  true); // internal attrs
    cd.setUint32(38, 0,  true); // external attrs
    cd.setUint32(42, offset, true); // local header offset
    const cdArr = new Uint8Array(cd.buffer);
    cdArr.set(nameBytes, 46);
    centralDir.push(cdArr);

    offset += lhArr.length + sz;
  }

  const cdSize   = centralDir.reduce((s, c) => s + c.length, 0);
  const eocd     = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0,  0x06054B50,      true);
  eocd.setUint16(4,  0,               true);
  eocd.setUint16(6,  0,               true);
  eocd.setUint16(8,  entries.length,  true);
  eocd.setUint16(10, entries.length,  true);
  eocd.setUint32(12, cdSize,          true);
  eocd.setUint32(16, offset,          true);
  eocd.setUint16(20, 0,               true);

  const all   = [...localChunks, ...centralDir, new Uint8Array(eocd.buffer)];
  const total = all.reduce((s, c) => s + c.length, 0);
  const zip   = new Uint8Array(total);
  let pos = 0;
  for (const chunk of all) { zip.set(chunk, pos); pos += chunk.length; }
  return zip;
}

// ════════════════════════════════════════════════════════════════════════
// FILE READING + ENCODING
// ════════════════════════════════════════════════════════════════════════
function readFileAsBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = e => res(e.target.result);
    fr.onerror = rej;
    fr.readAsArrayBuffer(file);
  });
}

function decodeBuffer(buffer, encoding) {
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return decoder.decode(buffer);
  } catch {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(buffer);
  }
}

function extractPeek(text, ext) {
  const e = (ext || '').toLowerCase();
  try {
    if (e === '.ass' || e === '.ssa') {
      // ASS format: Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{text}
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('Dialogue:')) {
          const parts = line.split(',');
          if (parts.length >= 10) {
            const rawText = parts.slice(9).join(',').replace(/\{[^}]+\}/g, '').trim();
            if (rawText) return rawText.substring(0, 100);
          }
        }
      }
    } else if (e === '.vtt') {
      const lines = text.split('\n');
      let skip = true;
      for (const line of lines) {
        if (skip && line.includes('-->')) { skip = false; continue; }
        if (!skip) {
          const clean = line.replace(/<[^>]+>/g, '').trim();
          if (clean && !clean.includes('-->')) return clean.substring(0, 100);
        }
      }
    } else {
      // SRT / default
      const lines = text.split('\n');
      let pastTimestamp = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t) { pastTimestamp = false; continue; }
        if (/^\d+$/.test(t)) continue;
        if (/\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}/.test(t)) {
          pastTimestamp = true; continue;
        }
        if (pastTimestamp && t) return t.substring(0, 100);
      }
    }
  } catch {}
  return '—';
}

async function processSubFile(subEntry) {
  try {
    const buffer = await readFileAsBuffer(subEntry.file);
    subEntry.rawBuffer = buffer;
    const text = decodeBuffer(buffer, currentEncoding);
    subEntry.peekText = extractPeek(text, subEntry.ext);
  } catch {
    subEntry.peekText = '[error reading file]';
  }
}

// ════════════════════════════════════════════════════════════════════════
// FILE INGESTION
// ════════════════════════════════════════════════════════════════════════
function getExt(name) {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}
function stripExt(name) {
  return name.replace(/(\.[^.]+)$/, '');
}

async function handleVideoFiles(files) {
  for (const f of files) {
    videoFiles.push({ file: f, name: f.name, ext: getExt(f.name), index: videoFiles.length });
  }
  renderVideoList();
  setStatus(`Loaded ${files.length} video file(s). Total: ${videoFiles.length}`);
}

async function handleSubFiles(files) {
  const startIdx = subFiles.length;
  for (const f of files) {
    const entry = { file: f, name: f.name, ext: getExt(f.name),
                    index: subFiles.length, matchedTo: null, newName: null,
                    rawBuffer: null, peekText: '…loading' };
    subFiles.push(entry);
  }
  renderSubList();
  // Process all new files
  const promises = [];
  for (let i = startIdx; i < subFiles.length; i++) {
    promises.push(processSubFile(subFiles[i]).then(() => renderSubItem(i)));
  }
  await Promise.all(promises);
  setStatus(`Loaded ${files.length} subtitle file(s). Total: ${subFiles.length}`);
}

// ════════════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════════════
function renderVideoList() {
  const list  = document.getElementById('videoList');
  const empty = document.getElementById('videoEmpty');
  const count = document.getElementById('videoCount');
  count.textContent = videoFiles.length;
  empty.style.display = videoFiles.length ? 'none' : 'flex';

  list.innerHTML = '';
  videoFiles.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.id = `vid-${i}`;
    item.innerHTML = `
      <div class="file-item-row">
        <span class="file-index">${i + 1}</span>
        <span class="file-name" title="${escHtml(v.name)}">${escHtml(stripExt(v.name))}</span>
        <span class="file-ext">${v.ext || 'vid'}</span>
        <span class="badge badge-video">VIDEO</span>
      </div>`;
    list.appendChild(item);
  });
}

function renderSubList() {
  const list  = document.getElementById('subList');
  const empty = document.getElementById('subEmpty');
  const count = document.getElementById('subCount');
  count.textContent = subFiles.length;
  empty.style.display = subFiles.length ? 'none' : 'flex';

  list.innerHTML = '';
  subFiles.forEach((_, i) => renderSubItem(i));
  updateMatchCount();
}

function renderSubItem(i) {
  const s    = subFiles[i];
  const list = document.getElementById('subList');
  let item   = document.getElementById(`sub-${i}`);

  if (!item) {
    item = document.createElement('div');
    item.id = `sub-${i}`;
    list.appendChild(item);
  }

  const matched  = s.matchedTo !== null;
  item.className = `file-item${matched ? ' matched' : ''}`;
  item.innerHTML = `
    <div class="file-item-row">
      <span class="file-index">${i + 1}</span>
      <span class="file-name" title="${escHtml(s.name)}">${escHtml(stripExt(s.name))}</span>
      <span class="file-ext">${s.ext || 'sub'}</span>
      <span class="badge ${matched ? 'badge-matched' : 'badge-ready'}">${matched ? '✓ MATCHED' : 'READY'}</span>
    </div>
    ${s.newName ? `<div class="file-name-new">→ ${escHtml(s.newName)}</div>` : ''}
    <div class="file-peek ${s.peekText === '…loading' ? 'loading' : ''}">${escHtml(s.peekText || '—')}</div>`;
}

function updateMatchCount() {
  const matched = subFiles.filter(s => s.matchedTo !== null).length;
  document.getElementById('matchCount').textContent = `${matched} / ${subFiles.length}`;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════════════════════
// ENCODING CHANGE — refresh all peeks
// ════════════════════════════════════════════════════════════════════════
document.getElementById('encodingSelect').addEventListener('change', async function() {
  currentEncoding = this.value;
  setStatus('Re-decoding all subtitles with new encoding…');
  const promises = subFiles.map((s, i) =>
    processSubFile(s).then(() => renderSubItem(i))
  );
  await Promise.all(promises);
  setStatus(`Encoding changed to ${currentEncoding}. Previews updated.`);
  toast('Previews updated with ' + currentEncoding, 'success');
});

// ════════════════════════════════════════════════════════════════════════
// MATCHING ALGORITHMS
// ════════════════════════════════════════════════════════════════════════
function extractEpisodeKey(name) {
  // Try S01E01, s01e01
  let m = name.match(/[Ss](\d{1,3})[Ee](\d{1,3})/);
  if (m) return `s${m[1].padStart(2,'0')}e${m[2].padStart(2,'0')}`;
  // Try 1x01
  m = name.match(/(\d{1,3})x(\d{1,3})/i);
  if (m) return `s${m[1].padStart(2,'0')}e${m[2].padStart(2,'0')}`;
  // Try EP01 or E01 standalone
  m = name.match(/[Ee][Pp]?[_\s]?(\d{1,4})/);
  if (m) return `ep${m[1].padStart(3,'0')}`;
  // Try plain number at end
  m = name.match(/[_\s\-\.](\d{1,4})[_\s\-\.]?(?:[^0-9]|$)/);
  if (m) return `n${m[1].padStart(4,'0')}`;
  return null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) =>
    Array.from({length: n+1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function buildMatches(matchFn) {
  if (!videoFiles.length || !subFiles.length) {
    toast('Add both video and subtitle files first.', 'error'); return;
  }
  const matches = matchFn();
  if (!matches.length) { toast('No matches found.', 'error'); return; }

  pendingMatches = matches;
  showMatchModal(matches);
}

function matchByEpisode() {
  buildMatches(() => {
    const vidMap = {};
    videoFiles.forEach((v, i) => {
      const key = extractEpisodeKey(v.name);
      if (key) vidMap[key] = i;
    });
    const results = [];
    subFiles.forEach((s, si) => {
      const key = extractEpisodeKey(s.name);
      if (key && vidMap[key] !== undefined) {
        const vi = vidMap[key];
        const newName = stripExt(videoFiles[vi].name) + s.ext;
        results.push({ subIdx: si, vidIdx: vi, newName });
      }
    });
    // Fallback: unmatched subs get alphabetical match
    const unmatchedSubs  = subFiles.map((s,i) => i).filter(i => !results.find(r => r.subIdx === i));
    const unmatchedVids  = videoFiles.map((v,i) => i).filter(i => !results.find(r => r.vidIdx === i));
    unmatchedSubs.forEach((si, idx) => {
      if (unmatchedVids[idx] !== undefined) {
        const vi = unmatchedVids[idx];
        const newName = stripExt(videoFiles[vi].name) + subFiles[si].ext;
        results.push({ subIdx: si, vidIdx: vi, newName, fallback: true });
      }
    });
    return results;
  });
}

function matchAlphabetical() {
  buildMatches(() => {
    const sortedVids = [...videoFiles].map((v,i) => ({...v, origIdx: i}))
                                      .sort((a,b) => a.name.localeCompare(b.name));
    const sortedSubs = [...subFiles].map((s,i) => ({...s, origIdx: i}))
                                    .sort((a,b) => a.name.localeCompare(b.name));
    const results = [];
    const len = Math.min(sortedVids.length, sortedSubs.length);
    for (let i = 0; i < len; i++) {
      const vi = sortedVids[i].origIdx;
      const si = sortedSubs[i].origIdx;
      const newName = stripExt(videoFiles[vi].name) + subFiles[si].ext;
      results.push({ subIdx: si, vidIdx: vi, newName });
    }
    return results;
  });
}

function showMatchModal(matches) {
  const modal   = document.getElementById('matchModal');
  const info    = document.getElementById('matchModalInfo');
  const list    = document.getElementById('matchPreviewList');
  info.textContent = `${matches.length} pair(s) found. Review before applying:`;
  list.innerHTML = matches.map(m => `
    <div class="match-preview-item">
      <div class="sub-name" title="${escHtml(subFiles[m.subIdx].name)}">${escHtml(subFiles[m.subIdx].name)}</div>
      <div class="arrow">→</div>
      <div class="vid-name" title="${escHtml(m.newName)}">${escHtml(m.newName)}</div>
    </div>`).join('');
  modal.classList.remove('hidden');
}

function applyMatches() {
  for (const m of pendingMatches) {
    subFiles[m.subIdx].matchedTo = m.vidIdx;
    subFiles[m.subIdx].newName   = m.newName;
  }
  renderSubList();
  closeModal();
  updateMatchCount();
  toast(`${pendingMatches.length} matches applied!`, 'success');
  setStatus(`Matched ${pendingMatches.length} subtitle(s).`);
}

function clearMatches() {
  subFiles.forEach(s => { s.matchedTo = null; s.newName = null; });
  renderSubList();
  updateMatchCount();
  toast('All matches cleared.', 'success');
}

function closeModal() {
  document.getElementById('matchModal').classList.add('hidden');
}

// ════════════════════════════════════════════════════════════════════════
// EXPORT — re-encode + rename
// ════════════════════════════════════════════════════════════════════════
async function getExportEntries() {
  const entries = [];
  for (const s of subFiles) {
    let buffer = s.rawBuffer;
    if (!buffer) {
      buffer = await readFileAsBuffer(s.file);
    }
    // Decode with selected encoding, re-encode as UTF-8
    const text    = decodeBuffer(buffer, currentEncoding);
    const outData = new TextEncoder().encode(text);
    const outName = s.newName || s.name;
    entries.push({ name: outName, data: outData, origName: s.name });
  }
  return entries;
}

async function downloadZip() {
  if (!subFiles.length) { toast('No subtitle files loaded.', 'error'); return; }
  setStatus('Building ZIP…');
  try {
    const entries = await getExportEntries();
    const zipData = createZip(entries);
    const blob    = new Blob([zipData], { type: 'application/zip' });
    triggerDownload(blob, 'subtitles_export.zip');
    toast(`ZIP created with ${entries.length} file(s)!`, 'success');
    setStatus(`ZIP downloaded: ${entries.length} files.`);
  } catch(e) {
    toast('ZIP creation failed: ' + e.message, 'error');
    setStatus('Error: ' + e.message);
  }
}

async function downloadSequential() {
  if (!subFiles.length) { toast('No subtitle files loaded.', 'error'); return; }
  const entries = await getExportEntries();
  setStatus(`Starting ${entries.length} sequential downloads…`);
  for (let i = 0; i < entries.length; i++) {
    const e    = entries[i];
    const blob = new Blob([e.data], { type: 'text/plain;charset=utf-8' });
    await new Promise(res => setTimeout(() => {
      triggerDownload(blob, e.name);
      res();
    }, i * 300));
  }
  toast(`${entries.length} file(s) downloaded sequentially.`, 'success');
  setStatus(`Downloaded ${entries.length} files.`);
}

// ════════════════════════════════════════════════════════════════════════
// .BAT SCRIPT GENERATOR
// Encoding: UTF-8 with BOM + @chcp 65001 for Persian/Arabic filenames
// ════════════════════════════════════════════════════════════════════════
function downloadBatScript() {
  const matched = subFiles.filter(s => s.matchedTo !== null && s.newName);
  if (!matched.length) {
    toast('No matched pairs to generate script for. Run matching first.', 'error'); return;
  }

  const lines = [
    '@echo off',
    'chcp 65001 > nul',
    'REM ── SubSync Rename Script ──',
    'REM Generated by SubSync — Subtitle & Video Manager',
    'REM Run this script in the folder containing your subtitle files.',
    'REM',
    '',
  ];

  for (const s of matched) {
    if (s.name !== s.newName) {
      lines.push(`ren "${s.name}" "${s.newName}"`);
    }
  }

  lines.push('', 'echo Done! Press any key to close.', 'pause > nul');

  const script = lines.join('\r\n');
  // UTF-8 BOM + content
  const BOM    = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const body   = new TextEncoder().encode(script);
  const all    = new Uint8Array(BOM.length + body.length);
  all.set(BOM, 0); all.set(body, BOM.length);
  const blob = new Blob([all], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'rename_subtitles.bat');
  toast('.bat script downloaded!', 'success');
  setStatus(`Batch rename script generated for ${matched.length} pairs.`);
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function setStatus(msg) {
  const el = document.getElementById('statusText');
  el.innerHTML = msg;
}

let toastTimer = {};
function toast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span> ${escHtml(msg)}`;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3500);
}

function clearAll() {
  videoFiles = []; subFiles = []; pendingMatches = [];
  renderVideoList(); renderSubList();
  updateMatchCount();
  setStatus('All files cleared.');
  toast('Cleared all files.', 'success');
}

function sortColumn(col) {
  if (col === 'video') {
    videoFiles.sort((a, b) => a.name.localeCompare(b.name));
    renderVideoList();
  } else {
    subFiles.sort((a, b) => a.name.localeCompare(b.name));
    subFiles.forEach((s, i) => s.index = i);
    renderSubList();
  }
  toast(`Sorted ${col} files alphabetically.`, 'success');
}

// ════════════════════════════════════════════════════════════════════════
// DRAG & DROP
// ════════════════════════════════════════════════════════════════════════
function dragOver(e, type) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById(type === 'video' ? 'videoDrop' : 'subDrop').classList.add('drag-over');
}
function dragLeave(e, type) {
  e.preventDefault();
  document.getElementById(type === 'video' ? 'videoDrop' : 'subDrop').classList.remove('drag-over');
}

async function dropFiles(e, type) {
  e.preventDefault();
  e.stopPropagation();
  const dropZoneId = type === 'video' ? 'videoDrop' : 'subDrop';
  document.getElementById(dropZoneId).classList.remove('drag-over');

  const items = [...(e.dataTransfer.items || [])];
  const files = [];

  // Handle both files and directory entries
  async function traverseEntry(entry) {
    if (entry.isFile) {
      await new Promise(res => entry.file(f => { files.push(f); res(); }));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      await new Promise(res => reader.readEntries(async entries => {
        for (const sub of entries) await traverseEntry(sub);
        res();
      }));
    }
  }

  if (items.length && items[0].webkitGetAsEntry) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await traverseEntry(entry);
    }
  } else {
    files.push(...(e.dataTransfer.files || []));
  }

  if (type === 'video') {
    const videoMimes = ['video/', '.mkv', '.avi', '.mp4', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.ts', '.webm'];
    const vids = files.filter(f =>
      videoMimes.some(m => f.type.startsWith(m.replace(/\./,'')) || f.name.toLowerCase().endsWith(m)));
    if (vids.length) await handleVideoFiles(vids);
    else toast('No recognized video files found in drop.', 'error');
  } else {
    const subExts = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx'];
    const subs = files.filter(f => subExts.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (subs.length) await handleSubFiles(subs);
    else {
      // If no subtitle extensions found, try accepting all dropped files as subs
      if (files.length) await handleSubFiles(files);
      else toast('No recognized subtitle files found in drop.', 'error');
    }
  }
}

// Also allow dropping anywhere on page but route to correct column based on drop target
document.addEventListener('dragover', e => e.preventDefault());

// Close modal on overlay click
document.getElementById('matchModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.ctrlKey && e.key === 'z') { clearMatches(); }
});

// ─── INIT STATUS ───
setStatus('Ready — drop video files on the left, subtitle files on the right.');