const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

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
  // 원본 이미지 그대로 base64로 전달 (resize 안 함)
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
  await sharp(filePath)
    .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: sharp.kernel.lanczos3 })
    .png().toFile(savePath);
  return savePath;
});

// ── Tab 4: PC 유사 이미지 찾기 ──
ipcMain.handle('phash:scan', async (event, { queryPath, scanDir }) => {
  const sharp = require('sharp');
  const imageExts = new Set(['.jpg','.jpeg','.png','.bmp','.gif','.webp','.tiff']);

  const queryMeta = await sharp(queryPath).metadata();
  const queryAR = queryMeta.width / queryMeta.height;
  const queryHist = await computeHistogram(queryPath);
  const queryHash = await computePHash(queryPath);

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
    if (allFiles[i] === queryPath) continue;
    try {
      const candMeta = await sharp(allFiles[i]).metadata();
      const candAR = candMeta.width / candMeta.height;

      // 종횡비 필터: 20% 이상 차이나면 스킵
      const arDiff = Math.abs(queryAR - candAR) / queryAR;
      if (arDiff > 0.20) { if(i%10===0) event.sender.send('phash:scan-progress',{current:i+1,total:allFiles.length}); continue; }

      // 1. 색상 히스토그램 유사도 (70% 가중)
      const candHist = await computeHistogram(allFiles[i]);
      const histSim = computeHistSimilarity(queryHist, candHist);

      // 2. pHash 유사도 (30% 가중)
      const candHash = await computePHash(allFiles[i]);
      const dist = hammingDistance(queryHash, candHash);
      const hashSim = Math.round((1 - dist / 64) * 100);

      // 3. 최종 유사도
      const finalSim = Math.round(histSim * 0.7 + hashSim * 0.3);

      if (finalSim >= 65) {
        const preview = await sharp(allFiles[i]).resize(120, 120, { fit: 'cover' }).png().toBuffer();
        results.push({
          filePath: allFiles[i],
          similarity: finalSim,
          width: candMeta.width,
          height: candMeta.height,
          preview: preview.toString('base64'),
        });
      }
    } catch(e) {}
    if (i % 10 === 0) event.sender.send('phash:scan-progress', {current:i+1,total:allFiles.length});
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, 50);
});

// 색상 히스토그램 (R/G/B/휘도 각 32번 구간)
async function computeHistogram(filePath) {
  const sharp = require('sharp');
  const { data, info } = await sharp(filePath)
    .resize(64, 64, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = 32;
  const rHist = new Float32Array(bins);
  const gHist = new Float32Array(bins);
  const bHist = new Float32Array(bins);

  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) {
    rHist[Math.floor(data[i]   / 256 * bins)]++;
    gHist[Math.floor(data[i+1] / 256 * bins)]++;
    bHist[Math.floor(data[i+2] / 256 * bins)]++;
  }

  // 정규화
  for (let i = 0; i < bins; i++) {
    rHist[i] /= pixels;
    gHist[i] /= pixels;
    bHist[i] /= pixels;
  }

  return { r: rHist, g: gHist, b: bHist };
}

// 지표함수(바타차르야 계수) 로 히스토그램 유사도
function computeHistSimilarity(h1, h2) {
  let sim = 0;
  const bins = h1.r.length;
  for (let i = 0; i < bins; i++) {
    sim += Math.min(h1.r[i], h2.r[i]);
    sim += Math.min(h1.g[i], h2.g[i]);
    sim += Math.min(h1.b[i], h2.b[i]);
  }
  return Math.round(sim / 3 * 100);
}

async function computePHash(filePath) {
  const sharp = require('sharp');
  const { data } = await sharp(filePath)
    .resize(32, 32, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = Array.from(data);
  const size = 32, dctSize = 8;
  const dct = [];
  for (let u = 0; u < dctSize; u++) {
    for (let v = 0; v < dctSize; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++)
        for (let y = 0; y < size; y++)
          sum += pixels[x*size+y] * Math.cos(((2*x+1)*u*Math.PI)/(2*size)) * Math.cos(((2*y+1)*v*Math.PI)/(2*size));
      const cu = u===0?1/Math.sqrt(2):1, cv = v===0?1/Math.sqrt(2):1;
      dct.push((2/size)*cu*cv*sum);
    }
  }
  dct.shift();
  const avg = dct.reduce((a,b)=>a+b,0)/dct.length;
  return dct.map(v => v > avg ? 1 : 0);
}

function hammingDistance(a, b) { let d=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++; return d; }

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
