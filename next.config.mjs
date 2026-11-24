/** @type {import('next').NextConfig} */
// GitHub Pages などサブパス配信時は NEXT_PUBLIC_BASE_PATH=/リポジトリ名 を指定
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};
export default nextConfig;
