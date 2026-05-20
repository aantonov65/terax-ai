import { cn } from "@/lib/utils";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import "@/components/dotmatrix-loader.css";

type DotMatrixLoaderProps = {
  className?: string;
  dotClassName?: string;
  label?: string;
};

export function DotMatrixLoader({
  className,
  dotClassName,
  label,
}: DotMatrixLoaderProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <DotmSquare3
        size={14}
        dotSize={2}
        animated
        className={cn("shrink-0 text-current", dotClassName)}
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
