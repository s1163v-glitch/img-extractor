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

ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized());

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

    const sendProgress = (status, imageCount, error) => {
      event.sender.send('extract:progress', {
        fileIndex: fi, fileTotal: filePaths.length,
        fileName: path.basename(filePath), status, imageCount, error,
      });
    };

    sendProgress('processing', 0);

    try {
      let count = 0;
      const onProgress = (n) => sendProgress('processing', n);

      if (ext === 'pptx' || ext === 'ppt') count = await extractFromPptx(filePath, fileOutputDir, onProgress);
      else if (ext === 'docx' || ext === 'doc') count = await extractFromDocx(filePath, fileOutputDir, onProgress);
      else if (ext === 'pdf') count = await extractFromPdf(filePath, fileOutputDir, onProgress);
      else if (ext === 'hwp' || ext === 'hwpx') count = await extractFromHwp(filePath, fileOutputDir, onProgress);

      results.push({ file: path.basename(filePath), count, outputDir: fileOutputDir, success: true });
      sendProgress('done', count);
    } catch (err) {
      results.push({ file: path.basename(filePath), count: 0, error: err.message, success: false });
      sendProgress('error', 0, err.message);
    }
  }

  return results;
});

// ── Extractors ────────────────────────────────────────────────────────────────

async function extractFromPptx(filePath, outputDir, onProgress) {
  const JSZip = require('jszip');
  const sharp = require('sharp');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));

  const slideRelsMap = {};
  const slideFiles = Object.keys(zip.files)
    .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1]) - parseInt(b.match(/slide(\d+)/)[1]));

  for (const slideFile of slideFiles) {
    const slideNum = parseInt(slideFile.match(/slide(\d+)/)[1]);
    const relsPath = slideFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    if (zip.files[relsPath]) {
      const relsXml = await zip.files[relsPath].async('string');
      const imageRels = [...relsXml.matchAll(/Type=".*\/image"[^>]*Target="([^"]+)"/g)];
      slideRelsMap[slideNum] = imageRels.map(m => {
        const t = m[1];
        return t.startsWith('../') ? 'ppt/' + t.replace('../', '') : `ppt/slides/${t}`;
      });
    }
  }

  let count = 0;
  for (const slideNum of Object.keys(slideRelsMap).map(Number).sort((a,b)=>a-b)) {
    const images = slideRelsMap[slideNum];
    for (let i = 0; i < images.length; i++) {
      if (!zip.files[images[i]]) continue;
      const buf = Buffer.from(await zip.files[images[i]].async('arraybuffer'));
      const out = path.join(outputDir, `${String(slideNum).padStart(3,'0')}-${String(i+1).padStart(2,'0')}.png`);
      try { await sharp(buf).png().toFile(out); count++; onProgress(count); } catch(e){}
    }
  }
  return count;
}

async function extractFromDocx(filePath, outputDir, onProgress) {
  const JSZip = require('jszip');
  const sharp = require('sharp');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const mediaFiles = Object.keys(zip.files)
    .filter(f => f.startsWith('word/media/') && !zip.files[f].dir)
    .sort();

  let count = 0;
  for (const mf of mediaFiles) {
    const ext = path.extname(mf).toLowerCase();
    if (!['.png','.jpg','.jpeg','.gif','.bmp','.tiff','.webp'].includes(ext)) continue;
    const buf = Buffer.from(await zip.files[mf].async('arraybuffer'));
    const out = path.join(outputDir, `${String(count+1).padStart(3,'0')}-01.png`);
    try { await sharp(buf).png().toFile(out); count++; onProgress(count); } catch(e){}
  }
  return count;
}

async function extractFromPdf(filePath, outputDir, onProgress) {
  const { PDFDocument } = require('pdf-lib');
  const sharp = require('sharp');

  const pdfBytes = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  let count = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx];
    const pageNum = String(pageIdx + 1).padStart(3, '0');

    // 페이지 리소스에서 XObject 이미지 추출
    const resources = page.node.get(page.node.context.obj('Resources'));
    if (!resources) continue;

    const xObjects = resources.get(resources.context.obj('XObject'));
    if (!xObjects) continue;

    let imgIdx = 0;
    const keys = xObjects.keys ? xObjects.keys() : [];

    for (const key of keys) {
      try {
        const xObj = xObjects.get(key);
        if (!xObj) continue;

        const subtype = xObj.get(xObj.context.obj('Subtype'));
        if (!subtype || subtype.toString() !== '/Image') continue;

        const filter = xObj.get(xObj.context.obj('Filter'));
        const filterName = filter ? filter.toString() : '';

        const imgData = xObj.get(xObj.context.obj('stream')) ||
                        (xObj.contents ? xObj.contents() : null);

        // 스트림 데이터 직접 접근
        let rawBytes;
        if (xObj.contents) {
          rawBytes = xObj.contents();
        } else if (xObj.sizeInBytes) {
          continue;
        } else {
          continue;
        }

        const imgNum = String(imgIdx + 1).padStart(2, '0');
        const outPath = path.join(outputDir, `${pageNum}-${imgNum}.png`);

        // JPEG 이미지
        if (filterName.includes('DCTDecode') || filterName.includes('DCT')) {
          await sharp(Buffer.from(rawBytes)).jpeg().png().toFile(outPath);
          count++; imgIdx++; onProgress(count);
          continue;
        }

        // PNG/기타는 sharp로 직접 변환 시도
        await sharp(Buffer.from(rawBytes)).png().toFile(outPath);
        count++; imgIdx++; onProgress(count);

      } catch(e) { /* 개별 이미지 실패 스킵 */ }
    }
  }

  // pdf-lib으로 이미지를 못 찾은 경우 JSZip 방식으로 폴백 (PDF 내부 스트림 raw 추출)
  if (count === 0) {
    count = await extractPdfRawImages(pdfBytes, outputDir, onProgress);
  }

  return count;
}

// PDF 바이트에서 JPEG/PNG 시그니처로 직접 이미지 추출 (폴백)
async function extractPdfRawImages(pdfBytes, outputDir, onProgress) {
  const sharp = require('sharp');
  const buf = Buffer.from(pdfBytes);
  let count = 0;
  let offset = 0;

  const jpegSig = Buffer.from([0xFF, 0xD8, 0xFF]);
  const jpegEnd = Buffer.from([0xFF, 0xD9]);
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  while (offset < buf.length - 8) {
    // JPEG 찾기
    if (buf[offset] === 0xFF && buf[offset+1] === 0xD8 && buf[offset+2] === 0xFF) {
      const end = buf.indexOf(jpegEnd, offset + 3);
      if (end !== -1 && end - offset > 100) {
        const imgBuf = buf.slice(offset, end + 2);
        const outPath = path.join(outputDir, `${String(count+1).padStart(3,'0')}-01.png`);
        try {
          await sharp(imgBuf).png().toFile(outPath);
          count++; onProgress(count);
          offset = end + 2;
          continue;
        } catch(e) {}
      }
    }
    // PNG 찾기
    if (buf[offset] === 0x89 && buf.slice(offset, offset+8).equals(pngSig)) {
      // PNG IEND 청크 찾기
      const iend = buf.indexOf(Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]), offset + 8);
      if (iend !== -1 && iend - offset > 100) {
        const imgBuf = buf.slice(offset, iend + 8);
        const outPath = path.join(outputDir, `${String(count+1).padStart(3,'0')}-01.png`);
        try {
          await sharp(imgBuf).png().toFile(outPath);
          count++; onProgress(count);
          offset = iend + 8;
          continue;
        } catch(e) {}
      }
    }
    offset++;
  }
  return count;
}

async function extractFromHwp(filePath, outputDir, onProgress) {
  const sharp = require('sharp');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.hwpx') {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const mediaFiles = Object.keys(zip.files)
      .filter(f => (f.includes('BinData') || f.includes('Contents/image')) && !zip.files[f].dir)
      .sort();
    let count = 0;
    for (let i = 0; i < mediaFiles.length; i++) {
      const buf = Buffer.from(await zip.files[mediaFiles[i]].async('arraybuffer'));
      const out = path.join(outputDir, `${String(i+1).padStart(3,'0')}-01.png`);
      try { await sharp(buf).png().toFile(out); count++; onProgress(count); } catch(e){}
    }
    return count;
  } else {
    try {
      const { toJson } = require('@ohah/hwpjs');
      const doc = JSON.parse(toJson(fs.readFileSync(filePath)));
      const binData = doc?.bodyText?.binData || doc?.binData || [];
      let count = 0;
      for (let i = 0; i < binData.length; i++) {
        if (!binData[i]?.data) continue;
        const buf = Buffer.from(binData[i].data, 'base64');
        const out = path.join(outputDir, `${String(i+1).padStart(3,'0')}-01.png`);
        try { await sharp(buf).png().toFile(out); count++; onProgress(count); } catch(e){}
      }
      return count;
    } catch(e) {
      throw new Error(`HWP 파싱 실패: ${e.message}`);
    }
  }
}
