type EnterEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'shiftKey'
  | 'ctrlKey'
  | 'altKey'
  | 'metaKey'
  | 'isComposing'
  | 'keyCode'
>;
export function shouldSendOnEnter(event: EnterEvent, touch: boolean): boolean {
  return (
    event.key === 'Enter' &&
    !touch &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}
