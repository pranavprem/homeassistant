import { describe, expect, it } from 'vitest';
import { CONTENT_BUDGET, PANEL_HEIGHT_TARGET_PX, type PanelId } from '../../src/model/budget.ts';
import { WIDE_COLUMNS } from '../../src/styles/layout.ts';

const GAP_PX = 16;
const COLUMN_LIMIT_PX = 700;

describe('content budget (§6.2.1)', () => {
  it('keeps every wide column at or below 700 px including gaps', () => {
    for (const column of WIDE_COLUMNS) {
      const height =
        column.reduce((sum, id: PanelId) => sum + PANEL_HEIGHT_TARGET_PX[id], 0) + (column.length - 1) * GAP_PX;
      expect(height, column.join(',')).toBeLessThanOrEqual(COLUMN_LIMIT_PX);
    }
  });

  it('pins the overview limits', () => {
    expect(CONTENT_BUDGET).toEqual({
      comfortTiles: 2,
      comfortTilesRoomy: 4,
      rooms: 6,
      vacuums: 2,
      activeAppliances: 3,
      cameras: 4,
      healthProblems: 3,
      upcomingEvents: 4,
    });
  });
});
