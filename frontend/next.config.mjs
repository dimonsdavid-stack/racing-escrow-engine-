export default {
  output: "export",
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  experimental: { cpus: 2 },
  webpack(config) {
    return config;
  },
};
