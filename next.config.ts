import type { NextConfig } from "next";

const apiTarget =
	process.env.API_PROXY_TARGET ||
	process.env.API_INTERNAL_URL ||
	(process.env.NODE_ENV !== "production" ? "http://127.0.0.1:4000" : null);

const nextConfig: NextConfig = {
	async rewrites() {
		return apiTarget
			? [{ source: "/api/:path*", destination: `${apiTarget}/:path*` }]
			: [];
	},
};

export default nextConfig;
