import React from "react";
import Svg, { Circle, Path } from "react-native-svg";

const BubbleIconOutlined = ({
  size = 24,
  color = "#ffffff",
  style,
}) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      style={style}
    >
      <Circle cx="139" cy="374" r="128" fill="none" stroke={color} strokeWidth="21" />

      <Path
        d="M224 385 A86 86 0 0 1 139 459"
        fill="none"
        stroke={color}
        strokeWidth="21"
        strokeLinecap="round"
      />

      <Circle cx="416" cy="267" r="85" fill="none" stroke={color} strokeWidth="21" />

      <Path
        d="M416 214 A53 53 0 0 1 469 267"
        fill="none"
        stroke={color}
        strokeWidth="21"
        strokeLinecap="round"
      />

      <Circle cx="256" cy="75" r="64" fill="none" stroke={color} strokeWidth="21" />

      <Path
        d="M256 43 A32 32 0 0 0 224 75"
        fill="none"
        stroke={color}
        strokeWidth="21"
        strokeLinecap="round"
      />

      <Circle cx="85" cy="139" r="43" fill="none" stroke={color} strokeWidth="21" />
    </Svg>
  );
};

export default BubbleIconOutlined;