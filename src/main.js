const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 600,
    minHeight: 480,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#2b2d31',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Window Controls ───────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized());

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '문서 파일 선택',
    filters: [
      { name: '지원 문서', extensions: ['pptx', 'ppt', 'docx', 'doc', 'pdf', 'hwp', 'hwpx'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '출력 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('shell:openFolder', async (_, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('extract:start', async (event, { filePaths, outputDir }) => {
  const results = [];

  for (let fi = 0; fi < filePaths.length; fi++) {
    const filePath = filePaths[fi];
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const baseName = path.basename(filePath, path.extname(filePath));
    const fileOutputDir = path.join(outputDir, baseName);

    if (!fs.existsSync(fileOutputDir)) fs.mkdirSync(fileOutputDir, { recursive: true });

    event.sender.send('extract:progress', {
      fileIndex: fi,
      fileTotal: filePaths.length,
      fileName: path.basename(filePath),
      status: 'processing',
      imageCount: 0,
    });

    try {
      let count = 0;

      if (ext === 'pptx' || ext === 'ppt') {
        count = await extractFromPptx(filePath, fileOutputDir, (n) => {
          event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'processing', imageCount: n });
        });
      } else if (ext === 'docx' || ext === 'doc') {
        count = await extractFromDocx(filePath, fileOutputDir, (n) => {
          event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'processing', imageCount: n });
        });
      } else if (ext === 'pdf') {
        count = await extractFromPdf(filePath, fileOutputDir, (n) => {
          event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'processing', imageCount: n });
        });
      } else if (ext === 'hwp' || ext === 'hwpx') {
        count = await extractFromHwp(filePath, fileOutputDir, (n) => {
          event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'processing', imageCount: n });
        });
      }

      results.push({ file: path.basename(filePath), count, outputDir: fileOutputDir, success: true });
      event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'done', imageCount: count });

    } catch (err) {
      results.push({ file: path.basename(filePath), count: 0, error: err.message, success: false });
      event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status: 'error', error: err.message });
    }
  }

  return results;
});

// ── Extractors ────────────────────────────────────────────────────────────────

async function extractFromPptx(filePath, outputDir, onProgress) {
  const JSZip = require('jszip');
  const sharp = require('sharp');
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const slideRelsMap = {};
  const slideFiles = Object.keys(zip.files)
    .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)[1]);
      const nb = parseInt(b.match(/slide(\d+)/)[1]);
      return na - nb;
    });

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)[1]);
    const relsPath = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    if (zip.files[relsPath]) {
      const relsXml = await zip.files[relsPath].async('string');
      const imageRels = [...relsXml.matchAll(/Type=".*\/image"[^>]*Target="([^"]+)"/g)];
      slideRelsMap[slideNum] = imageRels.map(m => {
        const target = m[1];
        return target.startsWith('../') ? 'ppt/' + target.replace('../', '') : `ppt/slides/${target}`;
      });
    }
  }

  let count = 0;
  const slideNums = Object.keys(slideRelsMap).map(Number).sort((a, b) => a - b);

  for (const slideNum of slideNums) {
    const images = slideRelsMap[slideNum];
    for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
      const imgPath = images[imgIdx];
      if (!zip.files[imgPath]) continue;
      const imgBuf = Buffer.from(await zip.files[imgPath].async('arraybuffer'));
      const pageStr = String(slideNum).padStart(3, '0');
      const imgStr = String(imgIdx + 1).padStart(2, '0');
      const outPath = path.join(outputDir, `${pageStr}-${imgStr}.png`);
      await sharp(imgBuf).png().toFile(outPath);
      count++;
      onProgress(count);
    }
  }
  return count;
}

async function extractFromDocx(filePath, outputDir, onProgress) {
  const JSZip = require('jszip');
  const sharp = require('sharp');
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const mediaFiles = Object.keys(zip.files)
    .filter(f => f.startsWith('word/media/') && !zip.files[f].dir)
    .sort();

  let count = 0;
  for (let i = 0; i < mediaFiles.length; i++) {
    const mediaFile = mediaFiles[i];
    const ext = path.extname(mediaFile).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp'];
    if (!imageExts.includes(ext)) continue;
    const imgBuf = Buffer.from(await zip.files[mediaFile].async('arraybuffer'));
    const imgStr = String(count + 1).padStart(3, '0');
    const outPath = path.join(outputDir, `${imgStr}-01.png`);
    try {
      await sharp(imgBuf).png().toFile(outPath);
      count++;
      onProgress(count);
    } catch (e) {}
  }
  return count;
}

async function extractFromPdf(filePath, outputDir, onProgress) {
  const sharp = require('sharp');
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdfDoc = await pdfjsLib.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  const numPages = pdfDoc.numPages;
  let count = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const ops = await page.getOperatorList();
    const imgNames = new Set();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintImageMaskXObject) {
        imgNames.add(ops.argsArray[i][0]);
      }
    }
    let imgIdx = 0;
    for (const imgName of imgNames) {
      try {
        const img = await new Promise((resolve) => page.objs.get(imgName, resolve));
        if (!img || !img.data) continue;
        const { width, height, data: rawData, kind } = img;
        const channels = kind === 3 ? 4 : 3;
        const rawBuf = Buffer.from(rawData);
        const pageStr = String(pageNum).padStart(3, '0');
        const imgStr = String(imgIdx + 1).padStart(2, '0');
        const outPath = path.join(outputDir, `${pageStr}-${imgStr}.png`);
        await sharp(rawBuf, { raw: { width, height, channels } }).png().toFile(outPath);
        count++; imgIdx++; onProgress(count);
      } catch (e) {}
    }
  }
  return count;
}

async function extractFromHwp(filePath, outputDir, onProgress) {
  const sharp = require('sharp');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.hwpx') {
    const JSZip = require('jszip');
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);
    const mediaFiles = Object.keys(zip.files)
      .filter(f => (f.includes('BinData') || f.includes('Contents/image')) && !zip.files[f].dir)
      .sort();
    let count = 0;
    for (let i = 0; i < mediaFiles.length; i++) {
      const imgBuf = Buffer.from(await zip.files[mediaFiles[i]].async('arraybuffer'));
      const imgStr = String(i + 1).padStart(3, '0');
      const outPath = path.join(outputDir, `${imgStr}-01.png`);
      try { await sharp(imgBuf).png().toFile(outPath); count++; onProgress(count); } catch (e) {}
    }
    return count;
  } else {
    try {
      const { toJson } = require('@ohah/hwpjs');
      const fileBuffer = fs.readFileSync(filePath);
      const jsonStr = toJson(fileBuffer);
      const doc = JSON.parse(jsonStr);
      const binData = doc?.bodyText?.binData || doc?.binData || [];
      let count = 0;
      for (let i = 0; i < binData.length; i++) {
        const item = binData[i];
        if (!item || !item.data) continue;
        const imgBuf = Buffer.from(item.data, 'base64');
        const imgStr = String(i + 1).padStart(3, '0');
        const outPath = path.join(outputDir, `${imgStr}-01.png`);
        try { await sharp(imgBuf).png().toFile(outPath); count++; onProgress(count); } catch (e) {}
      }
      return count;
    } catch (e) {
      throw new Error(`HWP 파싱 실패: ${e.message}`);
    }
  }
}
