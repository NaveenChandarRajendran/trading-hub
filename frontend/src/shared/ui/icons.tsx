// Inline SVG icons. They draw with currentColor, so the surrounding text color (and theme) sets their color.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
});

/** Two overlapping sheets. */
export function CopyIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

export function CheckIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}

/** Arrow pointer (select / move). */
export function CursorIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M4 2.5l8 6-3.6.6 2.1 4.1-1.5.8-2.1-4.1L4 12.5z" />
    </svg>
  );
}

/** A slanted line with its two ends. */
export function TrendLineIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M4 12L12 4" />
      <circle cx="3" cy="13" r="1.3" />
      <circle cx="13" cy="3" r="1.3" />
    </svg>
  );
}

export function RectangleIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <rect x="2.5" y="4" width="11" height="8" rx="0.5" />
    </svg>
  );
}

/** A dashed level with a price tag. */
export function HorizontalLineIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M1.5 8h2M5.5 8h2M9.5 8h1" />
      <rect x="11" y="6" width="3.5" height="4" rx="0.5" />
    </svg>
  );
}

export function TrashIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </svg>
  );
}

/** Four corners pointing out. */
export function MaximizeIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
    </svg>
  );
}

export function CloseIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
