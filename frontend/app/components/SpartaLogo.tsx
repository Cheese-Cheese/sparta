import React from "react";

export default function SpartaLogo({
  alt = "S.P.A.R.T.A. Spartan Shield Logo",
  className = "h-15 sm:h-18 w-auto shrink-0",
}: {
  alt?: string;
  className?: string;
}) {
  const id = React.useId();

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="370 139 284 366"
      className={className}
      fill="none"
      role="img"
      aria-label={alt}
    >
      <defs>
        {/* Metal Left Half: Charcoal in Light Mode, Polished Silver in Dark Mode */}
        <linearGradient
          id={`${id}-shield-metal`}
          x1="433"
          y1="208"
          x2="433"
          y2="489"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-0, #475569)" />
          <stop offset="0.5" stopColor="var(--logo-metal-50, #334155)" />
          <stop offset="1" stopColor="var(--logo-metal-100, #0f172a)" />
        </linearGradient>

        <linearGradient
          id={`${id}-helmet-metal`}
          x1="433"
          y1="335"
          x2="512"
          y2="322"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-100, #0f172a)" />
          <stop offset="1" stopColor="var(--logo-metal-0, #475569)" />
        </linearGradient>

        <linearGradient
          id={`${id}-metal-facet`}
          x1="489"
          y1="247"
          x2="467"
          y2="436"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-facet-0, #64748b)" />
          <stop offset="1" stopColor="var(--logo-metal-facet-100, #1e293b)" />
        </linearGradient>

        <linearGradient
          id={`${id}-metal-rim`}
          x1="481"
          y1="235"
          x2="457"
          y2="437"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-rim-0, #94a3b8)" />
          <stop offset="1" stopColor="var(--logo-metal-rim-100, #334155)" />
        </linearGradient>

        <linearGradient
          id={`${id}-dome-metal`}
          x1="480"
          y1="216"
          x2="454"
          y2="269"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-dome-0, #64748b)" />
          <stop offset="1" stopColor="var(--logo-metal-dome-100, #334155)" />
        </linearGradient>

        <linearGradient
          id={`${id}-nose-metal`}
          x1="512"
          y1="245"
          x2="512"
          y2="383"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--logo-metal-0, #475569)" />
          <stop offset="1" stopColor="var(--logo-metal-100, #0f172a)" />
        </linearGradient>

        {/* Crimson Right Half & Crest (Unified Vibrant Crimson) */}
        <linearGradient
          id={`${id}-shield-crimson`}
          x1="574"
          y1="207"
          x2="566"
          y2="486"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ff7587" />
          <stop offset="0.22" stopColor="#ff4d66" />
          <stop offset="0.50" stopColor="#e11d48" />
          <stop offset="0.80" stopColor="#be123c" />
          <stop offset="1" stopColor="#881337" />
        </linearGradient>

        <linearGradient
          id={`${id}-helmet-crimson`}
          x1="547"
          y1="219"
          x2="563"
          y2="449"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ff6b81" />
          <stop offset="0.30" stopColor="#f43f5e" />
          <stop offset="0.61" stopColor="#be123c" />
          <stop offset="1" stopColor="#881337" />
        </linearGradient>

        <linearGradient
          id={`${id}-crest`}
          x1="510"
          y1="155"
          x2="519"
          y2="225"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ff657d" />
          <stop offset="0.48" stopColor="#e11d48" />
          <stop offset="1" stopColor="#9f1239" />
        </linearGradient>

        <linearGradient
          id={`${id}-crest-edge`}
          x1="506"
          y1="156"
          x2="510"
          y2="224"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffa4b2" />
          <stop offset="1" stopColor="#be123c" />
        </linearGradient>
      </defs>

      <g id="emblem" aria-label="Spartan helmet inside a shield">
        <g id="shield">
          <path
            fill={`url(#${id}-shield-metal)`}
            d="M447.8 206.9 386.4 227.5V345.6C386.4 402.5 437.2 451.7 512 489.4V477.2C443.4 442.1 398.6 396.9 398.6 345.2V236.2L447.8 219.6Z"
          />
          <path
            fill={`url(#${id}-shield-crimson)`}
            d="M576.2 207.1 637.5 227.5V345.6C637.5 402.5 586.8 451.7 512 489.4V477.2C580.6 442.1 625.4 396.9 625.4 345.2V236.2L576.2 219.6Z"
          />
          <path
            fill="#ff8da0"
            opacity=".32"
            d="M576.2 207.1 637.5 227.5V345.6C637.5 380.6 618.2 413.2 585.9 442.1 616 412.7 635.5 380 635.5 345.2V229L576.2 209.2Z"
          />
        </g>
        <g id="helmet-crest">
          <path fill={`url(#${id}-crest)`} d="M505.7 154.9H518.4V224.3L512 221.1 505.7 224.3Z" />
          <path fill={`url(#${id}-crest-edge)`} d="M505.7 154.9H508.1V223.1L505.7 224.3Z" />
          <path fill="#ffa4b2" opacity=".45" d="M505.7 154.9H518.4L515.7 157.3H508.1Z" />
        </g>
        <g id="helmet-crown">
          <path
            fill={`url(#${id}-dome-metal)`}
            d="M433.4 274.1C443 243.1 463.4 220.4 497.5 215.6V231.2Z"
          />
          <path
            fill="var(--logo-metal-0, #ffffff)"
            opacity=".4"
            d="M433.4 274.1C443 243.1 463.4 220.4 497.5 215.6V219.6C469.6 224.3 449.7 245.9 433.4 274.1Z"
          />
          <path
            fill={`url(#${id}-helmet-crimson)`}
            d="M526.7 215.9C558 219 581.4 240.4 590.6 274.1L581.1 267.9C569.7 242.3 551 227 526.7 223.9Z"
          />
          <path
            fill="#ff8da0"
            opacity=".26"
            d="M526.7 215.9C558 219 581.4 240.4 590.6 274.1L587.4 271.9C578.1 241.7 555.5 221.9 526.7 218.1Z"
          />
        </g>
        <g id="helmet-metal-half">
          <path
            fill={`url(#${id}-helmet-metal)`}
            fillRule="evenodd"
            d="M512 232.2 428.2 288.1V339.2L452.5 361 470.6 417.3 441.4 388.2 445.2 366.5 438.7 359.5 432.3 391.1 490.6 448.6 482.1 347.8 454 329.3V306.5L499.5 330.4 494.5 367.4 512 383.7ZM499.5 266.1 469.4 286.7 499.5 306.6V296.8L482 286.7 499.5 275.8Z"
          />
          <path
            fill={`url(#${id}-metal-rim)`}
            d="M512 232.2 428.2 288.1V339.2L452.5 361 470.6 417.3 477.9 424.6 459.9 356.1 436.5 335.1V292.7L512 242.9Z"
          />
          <path
            fill={`url(#${id}-metal-facet)`}
            d="M445.4 293.1V334L474.7 352.9 483.8 437.7 490.6 448.6 482.1 347.8 454 329.3V306.5L499.5 330.4 502.3 321.7Z"
          />
          <path
            fill={`url(#${id}-metal-rim)`}
            opacity=".7"
            d="M445.4 293.1V334L474.7 352.9 483.8 437.7 480.2 350.2 450.2 331.3V301.2L499.5 327.1 502.3 321.7Z"
          />
          <path
            fill={`url(#${id}-nose-metal)`}
            opacity=".85"
            d="M512 242.9 507.8 247V374.9L500.1 364.5 504.6 327.8 499.5 330.4 494.5 367.4 512 383.7Z"
          />
        </g>
        <g id="helmet-crimson-half" fill={`url(#${id}-helmet-crimson)`}>
          <path d="M512 232.2 595.8 288.1V339.2L571.5 361 553.4 417.3 582.6 388.2 578.8 366.5 585.3 359.5 591.7 391.1 533.4 448.6 541.9 347.8 570 329.3V306.5L524.5 330.4 529.5 367.4 512 383.7V373.2L521.5 364.5 516 325.8 578.6 293.1V334L549.3 352.9 542.1 425.6 564.1 356.1 587.5 335.1V292.7L512 242.9Z" />
          <path d="M524.5 266.1 554.6 286.7 524.5 306.6V296.8L541.9 286.7 524.5 275.8Z" />
        </g>
      </g>
    </svg>
  );
}
