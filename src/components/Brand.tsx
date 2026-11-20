import Image from "next/image";

/** BRIN's emblem. Served unoptimized: the optimizer picked a blurry rendition on 2× screens. */
export function BrinEmblem({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <Image
      className={`ds-brin-emblem ${className}`}
      src="/brand/brin-emblem-192.png"
      alt="BRIN"
      width={size}
      height={size}
      unoptimized
    />
  );
}
