/**
 * embedder.js
 * MobileNetV2 ONNX 모델로 이미지 임베딩 벡터 추출
 *
 * 모델 저장: app.getPath('userData')/models/mobilenetv2.onnx
 * 없으면 여러 미러에서 순서대로 다운로드 시도, 이미 있으면 스킵
 */

const path = require('path');
const fs   = require('fs');

const MODEL_FILENAME = 'mobilenetv2.onnx';
const MIN_SIZE = 5 * 1024 * 1024; // 5MB 미만이면 불완전 파일로 판단

// 다운로드 시도 URL 목록 (순서대로 fallback)
const MODEL_URLS = [
  'https://github.com/onnx/models/raw/main/validated/vision/classification/mobilenet/model/mobilenetv2-10.onnx',
  'https://huggingface.co/qualcomm/MobileNet-v2/resolve/main/MobileNet-v2.onnx',
  'https://huggingface.co/onnx-community/mobilenetv2-10/resolve/main/model.onnx',
];

const MEAN = [0.485, 0.456, 0.406];
const STD  = [0.229, 0.224, 0.225];

let session   = null;
let modelPath = null;

function getModelPath(userDataPath) {
  const dir = path.join(userDataPath, 'models');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, MODEL_FILENAME);
}

// 단일 URL 다운로드 (리다이렉트 최대 10회)
function downloadOne(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const follow = (u) => {
      if (++hops > 10) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? require('https') : require('http');
      const req = mod.get(u, { timeout: 30000 }, (res) => {
        const { statusCode, headers } = res;
        if ([301, 302, 307, 308].includes(statusCode)) {
          res.resume();
          return follow(headers.location);
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + statusCode));
        }
        const total = parseInt(headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(received, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { try { fs.unlinkSync(dest); } catch(e){} reject(err); });
        res.on('error',  err => { try { fs.unlinkSync(dest); } catch(e){} reject(err); });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    };
    follow(url);
  });
}

// 여러 URL 순서대로 시도
async function downloadWithFallback(dest, onProgress) {
  const errors = [];
  for (let i = 0; i < MODEL_URLS.length; i++) {
    const url = MODEL_URLS[i];
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch(e){}
    try {
      onProgress && onProgress({ stage: 'downloading', pct: 0, src: hostname });
      await downloadOne(url, dest, (recv, total) => {
        onProgress && onProgress({ stage: 'downloading', pct: Math.round(recv / total * 100), src: hostname });
      });
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (size >= MIN_SIZE) return; // 성공
      try { fs.unlinkSync(dest); } catch(e){}
      errors.push(hostname + ': 파일 작음 (' + size + 'bytes)');
    } catch (e) {
      try { fs.unlinkSync(dest); } catch(ex){}
      errors.push(hostname + ': ' + e.message);
    }
  }
  throw new Error('모든 URL 실패 - 인터넷 연결 확인\n' + errors.join('\n'));
}

async function prepare(userDataPath, onProgress) {
  if (session) return;

  modelPath = getModelPath(userDataPath);

  const needDownload = !fs.existsSync(modelPath) || fs.statSync(modelPath).size < MIN_SIZE;
  if (needDownload) {
    await downloadWithFallback(modelPath, onProgress);
  }

  onProgress && onProgress({ stage: 'loading', pct: 0 });
  const ort = require('onnxruntime-node');
  session = await ort.InferenceSession.create(modelPath);
  onProgress && onProgress({ stage: 'ready', pct: 100 });
}

async function embed(imagePath) {
  if (!session) throw new Error('Model not loaded.');
  const sharp = require('sharp');
  const ort   = require('onnxruntime-node');

  const { data } = await sharp(imagePath)
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const chw = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    chw[0 * 224 * 224 + i] = (data[i * 3 + 0] / 255 - MEAN[0]) / STD[0];
    chw[1 * 224 * 224 + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1];
    chw[2 * 224 * 224 + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', chw, [1, 3, 224, 224]);
  const output = await session.run({ [inputName]: tensor });
  const outKey = session.outputNames[session.outputNames.length - 1];
  return Array.from(output[outKey].data);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.round(((sim + 1) / 2) * 100);
}

module.exports = { prepare, embed, cosineSimilarity, getModelPath };
