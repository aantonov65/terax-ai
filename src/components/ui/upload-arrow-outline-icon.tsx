import type { SVGProps } from "react";

type UploadArrowOutlineIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

export function UploadArrowOutlineIcon({
  size = 14,
  ...props
}: UploadArrowOutlineIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={3}
      {...props}
    >
      <path d="M12 21V7" />
      <path d="M4.5 13.5 12 6l7.5 7.5" />
    </svg>
  );
}
