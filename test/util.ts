export const nanoid = (t = 21) => {
    const rnd = crypto.getRandomValues(new Uint8Array(t));
    const newVar = (t: any, e: any) => t += (e &= 63) < 36 ? e.toString(36) : e < 62 ? (e - 26).toString(36).toUpperCase() : e > 62 ? "-" : "_";
    return rnd.reduce(newVar, "");
};