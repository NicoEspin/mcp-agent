export type SessionId = string;

export type MouseButton = 'left' | 'middle' | 'right';
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export type InputEvent =
  | {
      type: 'click';
      x: number;
      y: number;
      button?: MouseButton;
      clickCount?: number;
      modifiers?: Modifier[];
    }
  | { type: 'move'; x: number; y: number }
  | {
      type: 'down';
      x: number;
      y: number;
      button?: MouseButton;
      modifiers?: Modifier[];
    }
  | {
      type: 'up';
      x: number;
      y: number;
      button?: MouseButton;
      modifiers?: Modifier[];
    }
  | { type: 'wheel'; dx: number; dy: number }
  | { type: 'type'; text: string; delayMs?: number }
  | { type: 'press'; key: string; modifiers?: Modifier[] } // ✅ Added modifiers
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | {
      type: 'cmd';
      command: 'reload' | 'newTab' | 'closeTab' | 'switchTab' | 'listTabs';
      url?: string;
      tabId?: string;
    };
