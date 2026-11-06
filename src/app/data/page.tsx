import type { Metadata } from "next";
import { DataPanel } from "@/components/DataPanel";

export const metadata: Metadata = { title: "Your data — Food Discovery" };

export default function DataPage() {
  return <DataPanel />;
}
