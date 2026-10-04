import { Chip } from "@heroui/react";

/** 历史评价来源。没有标签时不渲染。 */
export function ReviewSourceLabel({ label }: { label?: string | null }) {
  if (!label) return null;
  return (
    <Chip size="sm" variant="soft">
      <Chip.Label>{label}</Chip.Label>
    </Chip>
  );
}
