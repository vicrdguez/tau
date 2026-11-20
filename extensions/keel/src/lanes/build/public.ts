/** Cost ranks are ordinal. A larger rank means a higher cost if wrong. */
export type Ruling = {
	what: string;
	why: string;
	cost: string;
	rank: number;
	follows: string;
};
