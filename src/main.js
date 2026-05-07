const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 620, minWidth: 680, minHeight: 520,
    frame: false, titleBarStyle: 'hidden', backgroundColor: '#2b2d31', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
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
ipcMain.handle('window:maximize', () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
ipcMain.handle('window:close', () => mainWindow.close());

ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '문서 파일 선택',
    filters: [{ name: '지원 문서', extensions: ['pptx','ppt','docx','doc','pdf','hwp','hwpx'] }, { name: '모든 파일', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections'],
  });
  return canceled ? [] : filePaths;
});
ipcMain.handle('dialog:openFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: '출력 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('dialog:openScanFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: '검색할 폴더 선택', properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('dialog:openImageFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '이미지 파일 선택',
    filters: [{ name: '이미지', extensions: ['png','jpg','jpeg','webp','bmp','tiff','gif'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('shell:openFolder', async (_, p) => shell.openPath(p));
ipcMain.handle('shell:openExternal', async (_, url) => shell.openExternal(url));
ipcMain.handle('shell:openPath', async (_, p) => shell.openPath(p));

// ── Tab 1: Extract ──
ipcMain.handle('extract:start', async (event, { filePaths, outputDir }) => {
  const results = [];
  for (let fi = 0; fi < filePaths.length; fi++) {
    const filePath = filePaths[fi];
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const baseName = path.basename(filePath, path.extname(filePath));
    const fileOutputDir = path.join(outputDir, baseName);
    if (!fs.existsSync(fileOutputDir)) fs.mkdirSync(fileOutputDir, { recursive: true });
    const send = (status, n, err) => event.sender.send('extract:progress', { fileIndex: fi, fileTotal: filePaths.length, fileName: path.basename(filePath), status, imageCount: n, error: err });
    send('processing', 0);
    try {
      let count = 0;
      const onP = n => send('processing', n);
      if (ext==='pptx'||ext==='ppt') count = await extractFromPptx(filePath, fileOutputDir, onP);
      else if (ext==='docx'||ext==='doc') count = await extractFromDocx(filePath, fileOutputDir, onP);
      else if (ext==='pdf') count = await extractFromPdf(filePath, fileOutputDir, onP);
      else if (ext==='hwp'||ext==='hwpx') count = await extractFromHwp(filePath, fileOutputDir, onP);
      results.push({ file: path.basename(filePath), count, outputDir: fileOutputDir, success: true });
      send('done', count);
    } catch(err) {
      results.push({ file: path.basename(filePath), count: 0, error: err.message, success: false });
      send('error', 0, err.message);
    }
  }
  return results;
});

// ── Tab 2: Resample ──
ipcMain.handle('resample:preview', async (_, { filePath }) => {
  const sharp = require('sharp');
  const buf = fs.readFileSync(filePath);
  const meta = await sharp(buf).metadata();
  const b64 = await sharp(buf).png().toBuffer();
  return { base64: b64.toString('base64'), width: meta.width, height: meta.height, size: buf.length };
});
ipcMain.handle('resample:save', async (_, { filePath, scale }) => {
  const sharp = require('sharp');
  const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow, {
    title: '저장', defaultPath: path.basename(filePath, path.extname(filePath)) + '_upscaled.png',
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !savePath) return null;
  const meta = await sharp(filePath).metadata();
  await sharp(filePath).resize(Math.round(meta.width*scale), Math.round(meta.height*scale), { kernel: sharp.kernel.lanczos3 }).png().toFile(savePath);
  return savePath;
});

// ── Tab 3: PC 유사 이미지 찾기 (ONNX 임베딩) ──

// 모델 준비 (UI에서 호출)
ipcMain.handle('model:prepare', async (event) => {
  const embedder = require('./embedder');
  const userDataPath = app.getPath('userData');

  try {
    await embedder.prepare(userDataPath, ({ stage, pct }) => {
      event.sender.send('model:progress', { stage, pct });
    });
    return { success: true };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('phash:scan', async (event, { queryPath, scanDir }) => {
  const sharp    = require('sharp');
  const embedder = require('./embedder');
  const crypto   = require('crypto');
  const imageExts = new Set(['.jpg','.jpeg','.png','.bmp','.gif','.webp','.tiff']);

  // 쿼리 이미지 정보
  const queryBuf  = fs.readFileSync(queryPath);
  const queryMD5  = crypto.createHash('md5').update(queryBuf).digest('hex');
  const queryMeta = await sharp(queryPath).metadata();
  const queryAR   = queryMeta.width / queryMeta.height;
  const queryBaseName = path.basename(queryPath, path.extname(queryPath)).toLowerCase();

  // 쿼리 임베딩
  const queryEmbed = await embedder.embed(queryPath);

  // 폴더 전체 스캔
  const allFiles = [];
  const walk = dir => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (imageExts.has(path.extname(f).toLowerCase())) allFiles.push(full);
        } catch(e) {}
      }
    } catch(e) {}
  };
  walk(scanDir);

  event.sender.send('phash:scan-total', allFiles.length);

  const results = [];

  for (let i = 0; i < allFiles.length; i++) {
    const candPath = allFiles[i];
    if (candPath === queryPath) {
      if (i % 5 === 0) event.sender.send('phash:scan-progress', { current: i+1, total: allFiles.length });
      continue;
    }

    try {
      const candBuf  = fs.readFileSync(candPath);
      const candMeta = await sharp(candPath).metadata();
      const candAR   = candMeta.width / candMeta.height;

      // ─ 1단계: MD5 완전 일치 → 복사본 ─
      const candMD5 = crypto.createHash('md5').update(candBuf).digest('hex');
      if (candMD5 === queryMD5) {
        const preview = await sharp(candPath).resize(120, 120, { fit: 'cover' }).png().toBuffer();
        results.push({ filePath: candPath, similarity: 100, matchType: 'exact', width: candMeta.width, height: candMeta.height, preview: preview.toString('base64') });
        if (i % 5 === 0) event.sender.send('phash:scan-progress', { current: i+1, total: allFiles.length });
        continue;
      }

      // ─ 2단계: 종횡비 필터 (20% 이내) ─
      if (Math.abs(queryAR - candAR) / queryAR > 0.20) {
        if (i % 5 === 0) event.sender.send('phash:scan-progress', { current: i+1, total: allFiles.length });
        continue;
      }

      // ─ 3단계: ONNX 임베딩 코사인 유사도 ─
      const candEmbed = await embedder.embed(candPath);
      let embedSim = embedder.cosineSimilarity(queryEmbed, candEmbed); // 0~100

      // ─ 4단계: 파일명 보너스 ─
      const candBase = path.basename(candPath, path.extname(candPath)).toLowerCase();
      if (candBase === queryBaseName) embedSim = Math.min(99, embedSim + 10);
      else if (candBase.includes(queryBaseName) || queryBaseName.includes(candBase)) embedSim = Math.min(99, embedSim + 5);

      // ─ 5단계: 해상도 방향 보너스 (후보가 더 크면) ─
      const qPx = queryMeta.width * queryMeta.height;
      const cPx = candMeta.width  * candMeta.height;
      if (cPx > qPx) embedSim = Math.min(99, embedSim + 3);

      if (embedSim >= 70) {
        const preview = await sharp(candPath).resize(120, 120, { fit: 'cover' }).png().toBuffer();
        results.push({
          filePath: candPath,
          similarity: embedSim,
          matchType: embedSim >= 90 ? 'high' : 'similar',
          width: candMeta.width, height: candMeta.height,
          preview: preview.toString('base64'),
        });
      }
    } catch(e) {}

    if (i % 5 === 0) event.sender.send('phash:scan-progress', { current: i+1, total: allFiles.length });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 50);
});

// ── Extractors ──
async function extractFromPptx(filePath, outputDir, onProgress) {
  const JSZip = require('jszip'), sharp = require('sharp');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideRelsMap = {};
  const slideFiles = Object.keys(zip.files).filter(f=>f.match(/^ppt\/slides\/slide\d+\.xml$/)).sort((a,b)=>parseInt(a.match(/slide(\d+)/)[1])-parseInt(b.match(/slide(\d+)/)[1]));
  for (const sf of slideFiles) {
    const sn=parseInt(sf.match(/slide(\d+)/)[1]);
    const rp=sf.replace('ppt/slides/','ppt/slides/_rels/')+'.rels';
    if (zip.files[rp]) {
      const rx=await zip.files[rp].async('string');
      slideRelsMap[sn]=[...rx.matchAll(/Type=".*\/image"[^>]*Target="([^"]+)"/g)].map(m=>{const t=m[1];return t.startsWith('../')?'ppt/'+t.replace('../',''):`ppt/slides/${t}`;});
    }
  }
  let count=0;
  for (const sn of Object.keys(slideRelsMap).map(Number).sort((a,b)=>a-b)) {
    for (let i=0;i<slideRelsMap[sn].length;i++) {
      if (!zip.files[slideRelsMap[sn][i]]) continue;
      const buf=Buffer.from(await zip.files[slideRelsMap[sn][i]].async('arraybuffer'));
      try { await sharp(buf).png().toFile(path.join(outputDir,`${String(sn).padStart(3,'0')}-${String(i+1).padStart(2,'0')}.png`)); count++; onProgress(count); } catch(e){}
    }
  }
  return count;
}
async function extractFromDocx(filePath, outputDir, onProgress) {
  const JSZip=require('jszip'), sharp=require('sharp');
  const zip=await JSZip.loadAsync(fs.readFileSync(filePath));
  const mf=Object.keys(zip.files).filter(f=>f.startsWith('word/media/')&&!zip.files[f].dir).sort();
  let count=0;
  for (const f of mf) {
    if (!['.png','.jpg','.jpeg','.gif','.bmp','.tiff','.webp'].includes(path.extname(f).toLowerCase())) continue;
    const buf=Buffer.from(await zip.files[f].async('arraybuffer'));
    try { await sharp(buf).png().toFile(path.join(outputDir,`${String(count+1).padStart(3,'0')}-01.png`)); count++; onProgress(count); } catch(e){}
  }
  return count;
}
async function extractFromPdf(filePath, outputDir, onProgress) {
  const { PDFDocument }=require('pdf-lib'), sharp=require('sharp');
  const pdfBytes=fs.readFileSync(filePath);
  const pdfDoc=await PDFDocument.load(pdfBytes,{ignoreEncryption:true});
  let count=0;
  for (let pi=0;pi<pdfDoc.getPages().length;pi++) {
    const page=pdfDoc.getPages()[pi], pageNum=String(pi+1).padStart(3,'0');
    try {
      const resources=page.node.get(page.node.context.obj('Resources'));
      if (!resources) continue;
      const xObjects=resources.get(resources.context.obj('XObject'));
      if (!xObjects) continue;
      let imgIdx=0;
      for (const key of (xObjects.keys?xObjects.keys():[])) {
        try {
          const xObj=xObjects.get(key);
          if (!xObj) continue;
          const subtype=xObj.get(xObj.context.obj('Subtype'));
          if (!subtype||subtype.toString()!=='/Image') continue;
          if (!xObj.contents) continue;
          await sharp(Buffer.from(xObj.contents())).png().toFile(path.join(outputDir,`${pageNum}-${String(imgIdx+1).padStart(2,'0')}.png`));
          count++; imgIdx++; onProgress(count);
        } catch(e){}
      }
    } catch(e){}
  }
  if (count===0) count=await extractPdfRawImages(pdfBytes,outputDir,onProgress);
  return count;
}
async function extractPdfRawImages(pdfBytes, outputDir, onProgress) {
  const sharp=require('sharp');
  const buf=Buffer.from(pdfBytes);
  let count=0,offset=0;
  const jpegEnd=Buffer.from([0xFF,0xD9]),pngSig=Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),iendSig=Buffer.from([0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]);
  while (offset<buf.length-8) {
    if (buf[offset]===0xFF&&buf[offset+1]===0xD8&&buf[offset+2]===0xFF) {
      const end=buf.indexOf(jpegEnd,offset+3);
      if (end!==-1&&end-offset>100){try{await sharp(buf.slice(offset,end+2)).png().toFile(path.join(outputDir,`${String(count+1).padStart(3,'0')}-01.png`));count++;onProgress(count);offset=end+2;continue;}catch(e){}}
    }
    if (buf[offset]===0x89&&buf.slice(offset,offset+8).equals(pngSig)) {
      const iend=buf.indexOf(iendSig,offset+8);
      if (iend!==-1&&iend-offset>100){try{await sharp(buf.slice(offset,iend+8)).png().toFile(path.join(outputDir,`${String(count+1).padStart(3,'0')}-01.png`));count++;onProgress(count);offset=iend+8;continue;}catch(e){}}
    }
    offset++;
  }
  return count;
}
async function extractFromHwp(filePath, outputDir, onProgress) {
  const sharp=require('sharp');
  const ext=path.extname(filePath).toLowerCase();
  if (ext==='.hwpx') {
    const JSZip=require('jszip');
    const zip=await JSZip.loadAsync(fs.readFileSync(filePath));
    const mf=Object.keys(zip.files).filter(f=>(f.includes('BinData')||f.includes('Contents/image'))&&!zip.files[f].dir).sort();
    let count=0;
    for (let i=0;i<mf.length;i++) {
      try{await sharp(Buffer.from(await zip.files[mf[i]].async('arraybuffer'))).png().toFile(path.join(outputDir,`${String(i+1).padStart(3,'0')}-01.png`));count++;onProgress(count);}catch(e){}
    }
    return count;
  } else {
    try {
      const {toJson}=require('@ohah/hwpjs');
      const doc=JSON.parse(toJson(fs.readFileSync(filePath)));
      const binData=doc?.bodyText?.binData||doc?.binData||[];
      let count=0;
      for (let i=0;i<binData.length;i++) {
        if (!binData[i]?.data) continue;
        try{await sharp(Buffer.from(binData[i].data,'base64')).png().toFile(path.join(outputDir,`${String(i+1).padStart(3,'0')}-01.png`));count++;onProgress(count);}catch(e){}
      }
      return count;
    } catch(e){throw new Error(`HWP 파싱 실패: ${e.message}`);}
  }
}
