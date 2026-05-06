# ImgExtractor

문서(PPTX, DOCX, PDF, HWP, HWPX)에서 이미지를 일괄 추출해 `페이지번호-그림번호.png` 형식으로 저장하는 Electron 데스크탑 앱.

## 파일명 규칙

| 형식 | 페이지 번호 기준 |
|---|---|
| PPTX | 슬라이드 번호 (001, 002...) |
| DOCX | 문서 내 이미지 순서 (001, 002...) |
| PDF | 페이지 번호 (001, 002...) |
| HWP/HWPX | 문서 내 이미지 순서 (001, 002...) |

예시: `003-02.png` = 3번 슬라이드/페이지의 2번째 이미지

## 설치 및 실행

```bash
npm install
npm start
```

## 빌드

```bash
# Windows
npm run build:win

# macOS
npm run build:mac
```

## 의존성

- `jszip` - PPTX, DOCX, HWPX 언패킹
- `pdfjs-dist` - PDF 이미지 추출
- `sharp` - 이미지 PNG 변환
- `hwp.js` - HWP 바이너리 파싱 (불완전할 수 있음)

## 주의사항

- **HWP 바이너리 파싱**은 `hwp.js`의 지원 범위에 따라 일부 파일에서 실패할 수 있음
- PDF의 경우 벡터 그래픽(SVG)은 추출되지 않고 래스터 이미지만 추출됨
- EMF/WMF 형식 이미지는 sharp가 처리하지 못해 스킵됨
