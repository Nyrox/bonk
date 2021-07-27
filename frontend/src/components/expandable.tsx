
import React, { FunctionComponent, ReactElement, useState } from "react"

export interface ExpandableProps {
    render: (expanded: boolean, onclick: (_: any) => void) => ReactElement
}

export const Expandable: FunctionComponent<ExpandableProps> = ({
    render
}) => {
    const [isExpanded, setIsExpanded] = useState(false)
    const element = render(isExpanded, (_) => setIsExpanded(!isExpanded))
    
    return element
}