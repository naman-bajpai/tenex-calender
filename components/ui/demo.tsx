import NavHeader from "@/components/ui/nav-header";
import { FloatingPathsBackground } from "@/components/ui/floating-paths";

function HomeDemo() {
  return (
    <header className="flex h-screen items-center justify-center p-10">
      <NavHeader />
    </header>
  );
}

export { HomeDemo };

export default function FloatingPathsBackgroundExample() {
  return (
    <FloatingPathsBackground
      className="aspect-16/9 flex items-center justify-center"
      position={-1}
    >
    </FloatingPathsBackground>
  );
}
