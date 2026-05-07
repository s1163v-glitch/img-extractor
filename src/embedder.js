/**
 * embedder.js
 * MobileNetV2 ONNX 모델을 사용해 이미지 임베딩 벡터를 추출하는 모듈
 *
 * 모델 저장 위치: app.getPath('userData')/models/mobilenetv2.onnx
 * 없으면 HuggingFace에서 자동 다운로드, 이미 있으면 스킵
 */

const path = require('path');
const fs   = require('fs');
const https = require('https');

// 모델 URL (MobileNetV2 feature extractor, ~14MB)
const MODEL_URL = 'https://huggingface.co/qualcomm/MobileNet-v2/resolve/main/MobileNet-v2.onnx';
const MODEL_FILENAME = 'mobilenetv2.onnx';

// ImageNet 정규화 파라미터
const MEAN = [0.485, 0.456, 0.406];
const STD  = [0.229, 0.224, 0.225];

let session = null;   // ONNX 세션 싱글턴
let modelPath = null;

/** 모델 파일 경로 반환 */
function getModelPath(userDataPath) {
  const modelsDir = path.join(userDataPath, 'models');
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
  return path.join(modelsDir, MODEL_FILENAME);
}

/** HTTP/HTTPS 리다이렉트 대응 다운로더 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);

        res.on('data', chunk => {
          received += chunk.length;
          if (total > 0 && onProgress) onProgress(received, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
        res.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * 모델 준비
 * - 이미 있으면: 바로 로드
 * - 없으면: 다운로드 후 로드
 * @param {string} userDataPath  app.getPath('userData')
 * @param {function} onProgress  ({ stage, pct }) => void
 */
async function prepare(userDataPath, onProgress) {
  if (session) return; // 이미 로드됨

  modelPath = getModelPath(userDataPath);

  // 다운로드 필요 여부 확인
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1024 * 1024) {
    onProgress && onProgress({ stage: 'downloading', pct: 0 });
    await download(MODEL_URL, modelPath, (recv, total) => {
      onProgress && onProgress({ stage: 'downloading', pct: Math.round(recv / total * 100) });
    });
    onProgress && onProgress({ stage: 'downloading', pct: 100 });
  }

  onProgress && onProgress({ stage: 'loading', pct: 0 });
  const ort = require('onnxruntime-node');
  session = await ort.InferenceSession.create(modelPath);
  onProgress && onProgress({ stage: 'ready', pct: 100 });
}

/**
 * 이미지 파일 → 임베딩 벡터 (Float32Array)
 * MobileNetV2 출력이 1000차원 분류 밟터 값이라도 특징으로 사용 가능
 */
async function embed(imagePath) {
  if (!session) throw new Error('Model not loaded. Call prepare() first.');

  const sharp = require('sharp');
  const ort   = require('onnxruntime-node');

  // 224x224 리사이즈 + 정규화
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

  // 마지막 출력 레이어 값 반환
  const outKey = session.outputNames[session.outputNames.length - 1];
  return Array.from(output[outKey].data);
}

/** 코사인 유사도 (0~100 정수) */
function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.round(((sim + 1) / 2) * 100); // -1~1 → 0~100
}

module.exports = { prepare, embed, cosineSimilarity, getModelPath };
