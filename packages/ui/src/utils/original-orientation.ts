export function originalOrientationLayout(width: number, imageWidth: number, imageHeight: number, rotated: boolean) {
  if (width <= 0 || imageWidth <= 0 || imageHeight <= 0) return null;
  const height = width * imageHeight / imageWidth;
  const scale = rotated ? width / height : 1;
  return { width, height, stageHeight: rotated ? width * scale : height, scale };
}
