"use client";

import React, { useRef, useState } from "react";
import { motion } from "framer-motion";

type CursorPosition = {
  left: number;
  width: number;
  opacity: number;
};

type TabProps = {
  children: React.ReactNode;
  setPosition: React.Dispatch<React.SetStateAction<CursorPosition>>;
};

function NavHeader() {
  const [position, setPosition] = useState<CursorPosition>({
    left: 0,
    width: 0,
    opacity: 0,
  });

  return (
    <ul
      className="relative mx-auto flex w-fit rounded-full border border-border bg-background p-1"
      onMouseLeave={() => setPosition((previous) => ({ ...previous, opacity: 0 }))}
    >
      <Tab setPosition={setPosition}>Home</Tab>
      <Tab setPosition={setPosition}>Pricing</Tab>
      <Tab setPosition={setPosition}>About</Tab>
      <Tab setPosition={setPosition}>Services</Tab>
      <Tab setPosition={setPosition}>Contact</Tab>

      <Cursor position={position} />
    </ul>
  );
}

function Tab({ children, setPosition }: TabProps) {
  const ref = useRef<HTMLLIElement>(null);
  return (
    <li
      ref={ref}
      onMouseEnter={() => {
        if (!ref.current) return;

        const { width } = ref.current.getBoundingClientRect();
        setPosition({
          width,
          opacity: 1,
          left: ref.current.offsetLeft,
        });
      }}
      className="relative z-10 block cursor-pointer px-3 py-1.5 text-xs uppercase text-foreground mix-blend-difference md:px-5 md:py-3 md:text-base"
    >
      {children}
    </li>
  );
}

function Cursor({ position }: { position: CursorPosition }) {
  return (
    <motion.li
      animate={position}
      className="absolute z-0 h-7 rounded-full bg-foreground md:h-12"
    />
  );
}

export default NavHeader;
