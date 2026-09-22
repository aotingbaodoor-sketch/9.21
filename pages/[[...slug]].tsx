import dynamic from "next/dynamic";

const CRM = dynamic(() => import("../src/App.tsx"), { ssr: false });

export default function CrmPage() {
  return <CRM />;
}
