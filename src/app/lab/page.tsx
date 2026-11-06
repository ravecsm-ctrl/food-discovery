import type { Metadata } from "next";
import { LabPanel } from "@/components/LabPanel";

export const metadata: Metadata = { title: "Lab — Prototype evaluation" };

export default function LabPage() {
  return <LabPanel />;
}
