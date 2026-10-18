import Image from "next/image";

export default function SpartaLogo({
  alt = "",
  className = "h-12 sm:h-14 w-auto shrink-0",
}: {
  alt?: string;
  className?: string;
}) {
  return (
    <Image
      src="/sparta-shield.svg"
      alt={alt}
      width={284}
      height={366}
      className={className}
    />
  );
}
