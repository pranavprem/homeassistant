import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStatusBoard } from '../../src/ha/status-board.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createStatusBoard', () => {
  it('stores one line per source', () => {
    const board = createStatusBoard();
    board.set('forecast', 'hourly live');
    board.set('live-view', 'native');
    expect(board.get('forecast')).toBe('hourly live');
    expect(board.get('live-view')).toBe('native');
    expect(board.get('calendar')).toBeUndefined();
  });

  it('notifies subscribers only when a line changes, until they unsubscribe', () => {
    const board = createStatusBoard();
    const listener = vi.fn();
    const unsubscribe = board.subscribe(listener);
    board.set('forecast', 'hourly live');
    board.set('forecast', 'hourly live');
    board.set('forecast', 'daily fallback');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    board.set('forecast', 'unsupported');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps notifying other subscribers when one throws, logging a code only', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const board = createStatusBoard();
    const healthy = vi.fn();
    board.subscribe(() => {
      throw new Error('listener bug');
    });
    board.subscribe(healthy);
    board.set('calendar', 'error');
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[agraharam]', 'status-listener-failed');
  });
});
