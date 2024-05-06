import shortUUID from "short-uuid";

const shortUUIDGenerator = shortUUID(shortUUID.constants.flickrBase58)
it("short uuid", () => {
    const x = "d6bea220-5041-7038-03e5-445c2d7b349f"
    console.log(shortUUIDGenerator.fromUUID(x))
    console.log(shortUUIDGenerator.fromUUID(x+x))
    console.log(shortUUIDGenerator.toUUID('fsgQYvcV3XJrgJV3ydJ7hpZCjAPRfgjFDFff3uCwJHQc'))
})