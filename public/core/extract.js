// 파일(txt/pdf/docx) → 서버 POST /documents/extract 로 글자만 뽑는다. 원본은 저장하지 않는다.
import { api } from './api.js';

export const MAX_FILE = 5 * 1024 * 1024;
export const FILE_ACCEPT = '.txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function extractFile(file) {
  if (file.size > MAX_FILE) throw new Error('파일은 5MB 이하만 올릴 수 있습니다.');
  const content_base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('파일을 읽지 못했습니다.')); r.readAsDataURL(file); });
  return api('/documents/extract', { method: 'POST', idempotent: true, body: { filename: file.name, mime_type: file.type, content_base64 } });
}
