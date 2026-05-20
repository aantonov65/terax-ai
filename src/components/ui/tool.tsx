import { cn } from "@/lib/utils"
import {
  CheckCircle,
  Loader2,
  Settings,
  XCircle,
} from "lucide-react"
import type { ReactNode } from "react"

export type ToolStateVariant =
  | "pending"
  | "running"
  | "ready"
  | "completed"
  | "review"
  | "blocked"
  | "error"

export type ToolPart = {
  type: string
  state:
    | "approval-requested"
    | "approval-responded"
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-denied"
    | "output-error"
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  toolCallId?: string
  errorText?: string
  displayName?: string
  summary?: string | null
  stateLabel?: string
  stateVariant?: ToolStateVariant
}

export type ToolProps = {
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
  children?: ReactNode
  hasDetails?: boolean
}

const Tool = ({
  toolPart,
  className,
}: ToolProps) => {
  const { state } = toolPart
  const variant = toolPart.stateVariant ?? variantFromState(state)

  const getStateIcon = () => {
    switch (variant) {
      case "running":
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
      case "ready":
        return <Settings className="h-4 w-4 text-orange-500" />
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "review":
        return <Settings className="h-4 w-4 text-amber-500" />
      case "blocked":
      case "error":
        return <XCircle className="h-4 w-4 text-red-500" />
      default:
        return <Settings className="text-muted-foreground h-4 w-4" />
    }
  }

  const getStateBadge = () => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-medium"
    const label = toolPart.stateLabel
    switch (variant) {
      case "running":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            )}
          >
            {label ?? "Processing"}
          </span>
        )
      case "ready":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
            )}
          >
            {label ?? "Ready"}
          </span>
        )
      case "completed":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            )}
          >
            {label ?? "Completed"}
          </span>
        )
      case "review":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
            )}
          >
            {label ?? "Needs review"}
          </span>
        )
      case "blocked":
      case "error":
        return (
          <span
            className={cn(
              baseClasses,
              "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
            )}
          >
            {label ?? (variant === "blocked" ? "Blocked" : "Error")}
          </span>
        )
      default:
        return (
          <span
            className={cn(
              baseClasses,
              "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
            )}
          >
            {label ?? "Pending"}
          </span>
        )
    }
  }

  return (
    <div
      className={cn(
        "border-border mt-3 overflow-hidden rounded-lg border bg-muted/50",
        className
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {getStateIcon()}
          <span className="shrink-0 font-mono text-sm font-medium">
            {toolPart.displayName ?? toolPart.type}
          </span>
          {getStateBadge()}
          {toolPart.summary ? (
            <span className="min-w-0 truncate text-left text-xs text-muted-foreground">
              {toolPart.summary}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export { Tool }

function variantFromState(state: ToolPart["state"]): ToolStateVariant {
  switch (state) {
    case "input-streaming":
    case "approval-responded":
      return "running"
    case "approval-requested":
    case "input-available":
      return "ready"
    case "output-available":
      return "completed"
    case "output-denied":
      return "blocked"
    case "output-error":
      return "error"
    default:
      return "pending"
  }
}
