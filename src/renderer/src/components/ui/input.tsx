// Adapted from shadcn/ui (new-york-v4) for Fluxy's compact desktop controls.
import * as React from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
    return (
        <input
            type={type}
            data-slot="input"
            className={cn(
                'min-w-0 rounded-[5px] border border-input bg-field px-[7px] py-[5px] text-[1rem] text-foreground transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-40',
                'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/15',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
                className
            )}
            {...props}
        />
    )
}

export { Input }
