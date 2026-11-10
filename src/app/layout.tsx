import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة إدارة توليد الوسائط",
  description:
    "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع، مع لوحة إدارة عربية ومفاتيح API بتوبديل تسلسلي تلقائي",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        {/* خط عربي جيد — يُحمَّل وقت التشغيل من Google Fonts مع بدائل محلية */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground" style={{ fontFamily: "'Cairo', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif" }}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
