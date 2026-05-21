import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface BoxFrameTheme {
  border: (text: string) => string;
}

const roundedBorder = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  separatorLeft: '├',
  separatorRight: '┤',
};

export function renderTopBorder(width: number, theme: BoxFrameTheme, title?: string): string {
  if (width <= 1) {
    return theme.border(roundedBorder.horizontal.repeat(Math.max(0, width)));
  }

  const titleText = title ? ` ${title.trim()} ` : '';
  const clippedTitle = truncateToWidth(titleText, Math.max(0, width - 2));
  const remaining = Math.max(0, width - 2 - visibleWidth(clippedTitle));
  return theme.border(`${roundedBorder.topLeft}${clippedTitle}${roundedBorder.horizontal.repeat(remaining)}${roundedBorder.topRight}`);
}

export function renderSeparator(width: number, theme: BoxFrameTheme): string {
  if (width <= 1) {
    return theme.border(roundedBorder.horizontal.repeat(Math.max(0, width)));
  }

  return theme.border(`${roundedBorder.separatorLeft}${roundedBorder.horizontal.repeat(Math.max(0, width - 2))}${roundedBorder.separatorRight}`);
}

export function renderBottomBorder(width: number, theme: BoxFrameTheme): string {
  if (width <= 1) {
    return theme.border(roundedBorder.horizontal.repeat(Math.max(0, width)));
  }

  return theme.border(`${roundedBorder.bottomLeft}${roundedBorder.horizontal.repeat(Math.max(0, width - 2))}${roundedBorder.bottomRight}`);
}

export function renderFrameLine(content: string, innerWidth: number, theme: BoxFrameTheme): string {
  const clipped = truncateToWidth(content, innerWidth);
  const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${theme.border(roundedBorder.vertical)}${clipped}${padding}${theme.border(roundedBorder.vertical)}`;
}
