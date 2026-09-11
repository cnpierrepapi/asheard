import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "As Heard",
    short_name: "As Heard",
    description: "Read what actually happened to a CALL-E call, and see which field said so.",
    start_url: "/",
    display: "standalone",
    background_color: "#1c1112",
    theme_color: "#1c1112",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
  };
}
