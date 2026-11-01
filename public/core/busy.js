// 작업 이름을 버튼과 보조 기술에 함께 알리고, 성공·실패·취소 모두 원래 상태로 돌린다.
export function busyButton(button, text) {
  if (!button) return () => {};
  const label = button.innerHTML;
  const disabled = button.disabled;
  button.disabled = true;
  button.textContent = text;
  button.setAttribute('aria-busy', 'true');
  return () => {
    button.innerHTML = label;
    button.disabled = disabled;
    button.removeAttribute('aria-busy');
  };
}
