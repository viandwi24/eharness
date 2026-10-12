// Which edges of a horizontally scrolling strip have more content behind them (the mobile bottom
// bar fades there so it is clear it scrolls). Pure, unit-tested.
export function scrollFades(scrollLeft: number, clientWidth: number, scrollWidth: number): { left: boolean; right: boolean } {
	return { left: scrollLeft > 2, right: scrollLeft + clientWidth < scrollWidth - 2 };
}
