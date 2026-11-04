import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title:'Anyone Privacy Lab', description:'See what a destination server learns from direct and Anyone-routed requests. An independent community lab for the Anyone network.', icons:{icon:'/favicon.svg'} };
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="en"><body>{children}</body></html>}
