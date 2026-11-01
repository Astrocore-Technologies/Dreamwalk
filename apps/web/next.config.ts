import type { NextConfig } from 'next';
const candidateDist = process.env.DREAMWALK_WEB_DIST_DIR;
if (candidateDist && !/^\.next-[a-z0-9-]{1,40}$/.test(candidateDist))
  throw new Error('Invalid local build directory');
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  distDir: candidateDist || (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.API_URL || 'http://127.0.0.1:4000'}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};
export default config;
