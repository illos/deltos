import type { ReactNode, SVGProps } from 'react';

/**
 * Shared props for every deltos icon. Each icon is a thin wrapper over {@link IconBase}, so it
 * accepts all standard SVG props (className, style, onClick, …) plus `size` and `title`.
 */
export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Width AND height, in px (number) or any CSS length (string). Default 20. */
  size?: number | string;
  /**
   * Accessible label. When provided the icon is exposed as `role="img"` with a `<title>`; when
   * omitted the icon is `aria-hidden` (decorative — label the surrounding control instead).
   */
  title?: string;
}

interface IconBaseProps extends IconProps {
  children: ReactNode;
}

/**
 * The shared SVG frame for the hand-rolled icon set (no icon font, no icon library — see the UI
 * refresh design packet). Fixed 24×24 grid; `currentColor` strokes so theme tokens color them
 * (`style={{ color: 'var(--secondary)' }}` or any `color`); round caps + joins for the fine-line
 * look. Per-icon overrides (a heavier `strokeWidth`, a filled shape) ride through normally — the
 * `{...rest}` spread is last so a caller can override any default, including `fill`/`stroke`.
 */
export function IconBase({
  size = 20,
  title,
  strokeWidth = 1.5,
  children,
  ...rest
}: IconBaseProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}
