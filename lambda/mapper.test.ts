import map, {Mapping} from "@app/lambda/mapper";

describe("Mapper", () => {

    it("maps properties", () => {
        const source = {
            OwnerName: "Some Name",
            OwnerAddress: {
                AddressLines: ['line 1', 'line 2'],
                City: "Some City",
                Country: "Some Country",
                PostalCode: "12345"
            }
        };
        const destination = {
            owner: {
                address_line1: "line 1",
                address_line2: "line 2",
                city: "Some City",
                country: "Some Country",
                name: "Some Name",
                zip: "12345"
            }
        };
        const mapping: Mapping<typeof source, typeof destination> = [
            [['OwnerName'], ['owner', 'name']],
            [['OwnerAddress', 'AddressLines', '0'], ['owner', 'address_line1']],
            [['OwnerAddress', 'AddressLines', '1'], ['owner', 'address_line2']],
            [['OwnerAddress', 'PostalCode'], ['owner', 'zip']],
            [['OwnerAddress', 'Country'], ['owner', 'country']],
            [['OwnerAddress', 'City'], ['owner', 'city']],
        ]
        const mapper = map.object(mapping)
        expect(mapper.mapDirect(source)).toEqual(destination)
        expect(mapper.mapInverse(destination)).toEqual(source)
    })

    it("maps arrays", () => {
        const source = {
            Details: [{Name: "Some Name", Value: "Some Value"}]
        };
        const destination = {
            metadata: [{name: "Some Name", value: "Some Value"}]
        };
        const childMapping: Mapping<typeof source.Details[number], typeof destination.metadata[number]> = [
            [['Name'], ['name']],
            [['Value'], ['value']],
        ]
        const mapping: Mapping<typeof source, typeof destination> = [
            [['Details'], ['metadata'], map.arrayOfObjects(childMapping)]
        ]
        const mapper = map.object(mapping)
        expect(mapper.mapDirect(source)).toEqual(destination)
        expect(mapper.mapInverse(destination)).toEqual(source)
    })

    it("maps pascal to snake case", () => {
        const source = {
            OwnerName: "Some Name",
            OwnerAddress: {
                AddressLines: ['line 1', 'line 2'],
                City: "Some City",
                Country: "Some Country",
                PostalCode: "12345"
            }
        };

        const destination = {
            owner_name: "Some Name",
            owner_address: {
                address_lines: ['line 1', 'line 2'],
                city: "Some City",
                country: "Some Country",
                postal_code: "12345"
            }
        };
        const mapper = map.pascalToSnake<typeof source, typeof destination>()
        expect(mapper.mapDirect(source)).toEqual(destination)
        expect(mapper.mapInverse(destination)).toEqual(source)
    })

    it("maps camel to snake case", () => {

        const source = {
            ownerName: "Some Name",
            ownerAddress: {
                addressLines: ['line 1', 'line 2'],
                city: "Some City",
                country: "Some Country",
                postalCode: "12345"
            }
        };
        const destination = {
            owner_name: "Some Name",
            owner_address: {
                address_lines: ['line 1', 'line 2'],
                city: "Some City",
                country: "Some Country",
                postal_code: "12345"
            }
        };
        const mapper = map.camelToSnake<typeof source, typeof destination>()

        expect(mapper.mapDirect(source)).toEqual(destination)
        expect(mapper.mapInverse(destination)).toEqual(source)
    })


    it("complex mapping", () => {

        const source = {
            A: {X: 1, Y: 2},
            B: {X: 1, Y: 2},
            C: {X: 1, Y: 2},
        }
        const destination = {
            a: {left: 1, top: 2},
            b: {left: 1, top: 2},
            c: {left: 1, top: 2},
        };
        const valueMapper = map.object([
            [['x'], ['left']],
            [['y'], ['top']],
        ])
        const keyMapper = map.pascalToSnake<typeof source, any>()
        const mapper = map.pipe(keyMapper, map.record(valueMapper))
        expect(mapper.mapDirect(source)).toEqual(destination)
        expect(mapper.mapInverse(destination)).toEqual(source)
    })

})