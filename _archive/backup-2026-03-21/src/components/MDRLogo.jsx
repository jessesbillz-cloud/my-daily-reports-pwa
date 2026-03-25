import React from 'react'

function MDRLogo({ size = 36 }) {
  return (
    <img
      src="logo.jpg"
      alt="My Daily Reports"
      style={{
        width: size,
        height: size,
        borderRadius: size > 40 ? 8 : 4,
        objectFit: "contain"
      }}
    />
  )
}

export default MDRLogo
