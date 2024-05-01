
/**
 * Represents a user attribute.
 */
export type UserAttribute = {
    /**
     * Attribute name.
     */
    readonly name: string,
    /**
     * Attribute value.
     */
    readonly value: string,
    /**
     * For alias attributes indicates verification status, undefined for normal attributes.
     */
    readonly verified?: boolean
}
