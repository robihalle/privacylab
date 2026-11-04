import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title:'Anyone Privacy Lab', description:'Compare the source IP a website sees on a direct request and a request through the Anyone network.', icons:{icon:'/anyone-icon.png'} };
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en"><body>{children}</body></html>}
