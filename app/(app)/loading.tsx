import { LogoMark } from "@/components/Brand";

export default function Loading() {
  return (
    <div className="flex min-h-[85vh] flex-col items-center justify-center gap-6">
      <LogoMark className="h-20 w-20 animate-pulse" />
      <div className="h-[3px] w-36 overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] rounded-full bg-accent/70" />
      </div>
    </div>
  );
}
